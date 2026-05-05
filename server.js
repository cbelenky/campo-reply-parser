const express = require("express");
const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// Health check
app.get("/", (req, res) => res.json({
  status: "Campo Reply Parser running",
  next_poll: new Date(Date.now() + POLL_INTERVAL_MS).toISOString()
}));

// Manual trigger for testing
app.get("/poll-now", async (req, res) => {
  console.log(`[${ts()}] Manual poll triggered`);
  const results = await pollAndProcess();
  res.json({ results });
});

// ─── Main polling loop ────────────────────────────────────────────────────────

async function pollAndProcess() {
  console.log(`[${ts()}] Polling HubSpot for open insurance supplements...`);
  const results = [];

  try {
    const supplements = await getOpenSupplements();
    console.log(`[${ts()}] Found ${supplements.length} supplement(s) awaiting reply`);

    for (const supplement of supplements) {
      try {
        // Get the associated Deal
        const deal = await getAssociatedDeal(supplement.id);
        if (!deal) {
          console.log(`[${ts()}] Supplement ${supplement.id}: no associated deal found, skipping`);
          continue;
        }

        // Skip if deal already marked as replied
        if (deal.properties.insurance_reply_received === "true") {
          console.log(`[${ts()}] Supplement ${supplement.id}: deal already marked replied, skipping`);
          continue;
        }

        // Get latest inbound email on the supplement
        const email = await getLatestInboundEmail(supplement.id);
        if (!email) {
          console.log(`[${ts()}] Supplement ${supplement.id}: no inbound email found, skipping`);
          continue;
        }

        console.log(`[${ts()}] Supplement ${supplement.id}: analyzing email from ${email.from}`);

        // Ask Claude if it's human or automated
        const verdict = await classifyEmail(email);
        console.log(`[${ts()}] Supplement ${supplement.id}: verdict = ${verdict.verdict} (${verdict.confidence}) — ${verdict.reasoning}`);

        if (verdict.verdict === "HUMAN") {
          await markDealReplied(deal.id);
          console.log(`[${ts()}] Deal ${deal.id}: insurance_reply_received set to true`);
        }

        results.push({
          supplement_id: supplement.id,
          deal_id: deal.id,
          deal_name: deal.properties.dealname,
          from: email.from,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          reasoning: verdict.reasoning,
          hubspot_updated: verdict.verdict === "HUMAN",
        });

      } catch (suppErr) {
        console.error(`[${ts()}] Supplement ${supplement.id} error:`, suppErr.message);
        results.push({ supplement_id: supplement.id, error: suppErr.message });
      }
    }

  } catch (err) {
    console.error(`[${ts()}] Poll error:`, err.message);
  }

  return results;
}

// ─── HubSpot: get supplements — Submitted to Carrier + Project Consultant ────

async function getOpenSupplements() {
  const response = await fetch("https://api.hubapi.com/crm/v3/objects/2-27654244/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${HUBSPOT_API_KEY}`,
    },
    body: JSON.stringify({
      filterGroups: [{
        filters: [
          {
            propertyName: "hs_pipeline_stage",
            operator: "EQ",
            value: "173473972"
          },
          {
            propertyName: "supplement_team",
            operator: "EQ",
            value: "Project Consultant"
          }
        ]
      }],
      properties: ["hs_object_id", "hs_pipeline_stage", "supplement_team"],
      limit: 100,
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`HubSpot supplements search error: ${JSON.stringify(err)}`);
  }

  const data = await response.json();
  return data.results || [];
}

// ─── HubSpot: get the Deal associated with a Supplement ──────────────────────

async function getAssociatedDeal(supplementId) {
  const response = await fetch(
    `https://api.hubapi.com/crm/v3/objects/2-27654244/${supplementId}/associations/deals`,
    { headers: { "Authorization": `Bearer ${HUBSPOT_API_KEY}` } }
  );

  if (!response.ok) return null;
  const data = await response.json();
  const deals = data.results || [];
  if (deals.length === 0) return null;

  // Fetch the full deal object
  const dealResponse = await fetch(
    `https://api.hubapi.com/crm/v3/objects/deals/${deals[0].id}?properties=dealname,hubspot_owner_id,insurance_reply_received`,
    { headers: { "Authorization": `Bearer ${HUBSPOT_API_KEY}` } }
  );

  if (!dealResponse.ok) return null;
  return await dealResponse.json();
}

// ─── HubSpot: get latest inbound email on a supplement ───────────────────────

async function getLatestInboundEmail(supplementId) {
  const response = await fetch(
    `https://api.hubapi.com/crm/v3/objects/2-27654244/${supplementId}/associations/emails`,
    { headers: { "Authorization": `Bearer ${HUBSPOT_API_KEY}` } }
  );

  if (!response.ok) return null;
  const assocData = await response.json();
  const emailIds = (assocData.results || []).map(e => e.id);
  if (emailIds.length === 0) return null;

  // Fetch each email and find the latest inbound one
  const emails = [];
  for (const emailId of emailIds.slice(0, 10)) {
    const emailResponse = await fetch(
      `https://api.hubapi.com/crm/v3/objects/emails/${emailId}?properties=hs_email_direction,hs_email_subject,hs_email_text,hs_email_from_email,hs_timestamp`,
      { headers: { "Authorization": `Bearer ${HUBSPOT_API_KEY}` } }
    );
    if (!emailResponse.ok) continue;
    const emailData = await emailResponse.json();
    emails.push(emailData);
  }

  // Filter to inbound only and sort by most recent
  const inbound = emails
    .filter(e => e.properties.hs_email_direction === "INCOMING_EMAIL")
    .sort((a, b) => new Date(b.properties.hs_timestamp) - new Date(a.properties.hs_timestamp))[0];

  if (!inbound) return null;

  return {
    from: inbound.properties.hs_email_from_email || "unknown",
    subject: inbound.properties.hs_email_subject || "",
    body: inbound.properties.hs_email_text || "",
  };
}

// ─── HubSpot: mark the Deal as replied ───────────────────────────────────────

async function markDealReplied(dealId) {
  const response = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${HUBSPOT_API_KEY}`,
    },
    body: JSON.stringify({
      properties: { insurance_reply_received: true }
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`HubSpot deal update error: ${JSON.stringify(err)}`);
  }
}

// ─── Claude: classify the email ──────────────────────────────────────────────

async function classifyEmail({ from, subject, body }) {
  if (!body || body.trim().length === 0) {
    return { verdict: "AUTOMATED", confidence: "high", reasoning: "Empty email body — likely a system notification." };
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: `You are an AI assistant for Campo Roof, a roofing company in Cleveland, Ohio. They submit roofing estimates to insurance companies for April 15, 2025 hailstorm damage claims.

Analyze this inbound email reply and determine if it was written by a HUMAN or sent automatically by a system.

AUTOMATED signals:
- Generic acknowledgment with no specific content
- "Do not reply to this email" instructions
- Sent from noreply@ or donotreply@ addresses
- References to ticket/case numbers being auto-assigned
- No personal name signing off
- Boilerplate legal disclaimers with no human response

HUMAN signals:
- Asks specific questions about the estimate or claim
- References specific line items, dates, or property details
- Written in first person with natural language
- Signed with a real person's name and title
- Mentions scheduling, decisions, approvals, or next steps
- Any substantive response even if brief

From: ${from}
Subject: ${subject || "(no subject)"}
Body:
${body.substring(0, 2000)}

Respond ONLY with a JSON object, no markdown, no backticks:
{"verdict":"HUMAN" or "AUTOMATED","confidence":"high" or "medium" or "low","reasoning":"One sentence explaining your verdict."}`
      }]
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`Anthropic API error: ${JSON.stringify(data)}`);
  const raw = data.content.map(i => i.text || "").join("").trim();
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}

// ─── Start server + polling loop ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${ts()}] Campo Reply Parser listening on port ${PORT}`);
  console.log(`[${ts()}] Polling every ${POLL_INTERVAL_MS / 1000 / 60} minutes`);
  pollAndProcess();
  setInterval(pollAndProcess, POLL_INTERVAL_MS);
});
