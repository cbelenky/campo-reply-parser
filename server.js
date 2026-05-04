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

// Main polling loop
async function pollAndProcess() {
  console.log(`[${ts()}] Polling HubSpot for open insurance claim deals...`);
  const results = [];

  try {
    const deals = await getOpenDeals();
    console.log(`[${ts()}] Found ${deals.length} deal(s) awaiting reply`);

    for (const deal of deals) {
      try {
        const email = await getLatestInboundEmail(deal.id);
        if (!email) {
          console.log(`[${ts()}] Deal ${deal.id}: no inbound email found, skipping`);
          continue;
        }

        console.log(`[${ts()}] Deal ${deal.id}: analyzing email from ${email.from}`);

        const verdict = await classifyEmail(email);
        console.log(`[${ts()}] Deal ${deal.id}: verdict = ${verdict.verdict} (${verdict.confidence})`);

        if (verdict.verdict === "HUMAN") {
          await markDealReplied(deal.id);
          console.log(`[${ts()}] Deal ${deal.id}: marked as replied in HubSpot`);
        }

        results.push({
          deal_id: deal.id,
          deal_name: deal.properties.dealname,
          from: email.from,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          reasoning: verdict.reasoning,
          hubspot_updated: verdict.verdict === "HUMAN",
        });

      } catch (dealErr) {
        console.error(`[${ts()}] Deal ${deal.id} error:`, dealErr.message);
        results.push({ deal_id: deal.id, error: dealErr.message });
      }
    }

  } catch (err) {
    console.error(`[${ts()}] Poll error:`, err.message);
  }

  return results;
}

// HubSpot: get deals where estimate sent but no reply yet
async function getOpenDeals() {
  const response = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${HUBSPOT_API_KEY}`,
    },
    body: JSON.stringify({
      filterGroups: [{
        filters: [
          { propertyName: "insurance_estimate_sent_date", operator: "HAS_PROPERTY" },
          { propertyName: "insurance_reply_received", operator: "NEQ", value: "true" }
        ]
      }],
      properties: ["dealname", "insurance_estimate_sent_date", "insurance_reply_received"],
      limit: 100,
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`HubSpot deals search error: ${JSON.stringify(data)}`);
  return data.results || [];
}

// HubSpot: get latest inbound email on a deal
async function getLatestInboundEmail(dealId) {
  const assocResponse = await fetch(
    `https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/conversations`,
    { headers: { "Authorization": `Bearer ${HUBSPOT_API_KEY}` } }
  );

  if (!assocResponse.ok) return null;
  const assocData = await assocResponse.json();
  const conversations = assocData.results || [];
  if (conversations.length === 0) return null;

  for (const conv of conversations) {
    const msgResponse = await fetch(
      `https://api.hubapi.com/conversations/v3/conversations/${conv.id}/messages?limit=20`,
      { headers: { "Authorization": `Bearer ${HUBSPOT_API_KEY}` } }
    );

    if (!msgResponse.ok) continue;
    const msgData = await msgResponse.json();
    const messages = msgData.results || [];

    const inbound = messages
      .filter(m => m.direction === "INCOMING")
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

    if (inbound) {
      return {
        from: inbound.senders?.[0]?.email || "unknown",
        subject: inbound.subject || "",
        body: inbound.text || inbound.richText || "",
      };
    }
  }

  return null;
}

// HubSpot: mark deal as replied
async function markDealReplied(dealId) {
  const response = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${HUBSPOT_API_KEY}`,
    },
    body: JSON.stringify({ properties: { insurance_reply_received: true } })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`HubSpot update error: ${JSON.stringify(err)}`);
  }
}

// Claude: classify the email
async function classifyEmail({ from, subject, body }) {
  if (!body || body.trim().length === 0) {
    return { verdict: "AUTOMATED", confidence: "high", reasoning: "Empty email body." };
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: `You are an AI assistant for Campo Roof, a roofing company in Cleveland, Ohio. They submit roofing estimates to insurance companies for April 15 hailstorm damage claims.

Analyze this inbound email and determine if it is a HUMAN reply or an AUTOMATED reply.

AUTOMATED: auto-acknowledgments, out-of-office messages, do-not-reply notifications, system confirmations, bouncebacks, or any message sent by a mail server or bot with no human decision-making.

HUMAN: any message where a real person is responding — questions, requests, decisions, scheduling, approval, denial, or any substantive content.

From: ${from}
Subject: ${subject || "(no subject)"}
Body:
${body.substring(0, 2000)}

Respond ONLY with a JSON object, no markdown, no backticks:
{"verdict":"HUMAN" or "AUTOMATED","confidence":"high" or "medium" or "low","reasoning":"One sentence."}`
      }]
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`Anthropic API error: ${JSON.stringify(data)}`);
  const raw = data.content.map(i => i.text || "").join("").trim();
  return JSON.parse(raw);
}

function ts() {
  return new Date().toISOString();
}

// Start server and polling loop
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${ts()}] Campo Reply Parser listening on port ${PORT}`);
  console.log(`[${ts()}] Polling every ${POLL_INTERVAL_MS / 1000 / 60} minutes`);
  pollAndProcess();
  setInterval(pollAndProcess, POLL_INTERVAL_MS);
});
