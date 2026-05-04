const express = require("express");
const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // optional but recommended

// Health check
app.get("/", (req, res) => res.json({ status: "Campo Reply Parser running" }));

// Main webhook endpoint — HubSpot calls this on every inbound email
app.post("/api/campo-reply-parser", async (req, res) => {
  try {
    const { from, subject, body, deal_id } = req.body;

    if (!from || !body || !deal_id) {
      return res.status(400).json({ error: "Missing required fields: from, body, deal_id" });
    }

    console.log(`[${new Date().toISOString()}] Analyzing reply for deal ${deal_id} from ${from}`);

    // Step 1: Ask Claude if this is a human or automated reply
    const verdict = await classifyEmail({ from, subject, body });
    console.log(`[${new Date().toISOString()}] Verdict: ${verdict.verdict} (${verdict.confidence}) — ${verdict.reasoning}`);

    // Step 2: If human, update HubSpot and stop the workflow
    if (verdict.verdict === "HUMAN") {
      await markDealReplied(deal_id);
      console.log(`[${new Date().toISOString()}] Deal ${deal_id} marked as replied in HubSpot`);
    }

    return res.json({
      deal_id,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      reasoning: verdict.reasoning,
      hubspot_updated: verdict.verdict === "HUMAN",
    });

  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Claude: classify the email
async function classifyEmail({ from, subject, body }) {
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
${body}

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

// HubSpot: set Insurance Reply Received = true on the Deal
async function markDealReplied(dealId) {
  const response = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${HUBSPOT_API_KEY}`,
    },
    body: JSON.stringify({
      properties: {
        insurance_reply_received: true,
      }
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`HubSpot API error: ${JSON.stringify(err)}`);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Campo Reply Parser listening on port ${PORT}`));
