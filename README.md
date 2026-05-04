# Campo Roof — Insurance Reply Parser

Webhook server that receives inbound email data from HubSpot, uses Claude AI to determine if the reply is from a real human or an automated system, and if human, updates the HubSpot Deal to stop the follow-up workflow.

---

## How it works

1. Insurance company replies to your shared HubSpot inbox
2. HubSpot fires a webhook to this server with the email details
3. Claude analyzes the email and returns HUMAN or AUTOMATED
4. If HUMAN → server patches the HubSpot Deal: `insurance_reply_received = true`
5. Your HubSpot workflow detects that property and stops sending follow-ups

---

## Setup: Step by step

### Step 1 — Get your API keys

**Anthropic API key:**
1. Go to https://console.anthropic.com
2. Click API Keys → Create Key
3. Copy the key (starts with sk-ant-)

**HubSpot Private App token:**
1. In HubSpot, go to Settings → Integrations → Private Apps
2. Click "Create a private app"
3. Name it "Campo Reply Parser"
4. Under Scopes, add: crm.objects.deals.write
5. Click Create → copy the token (starts with pat-na1-)

---

### Step 2 — Create the HubSpot custom Deal property

1. In HubSpot go to Settings → Properties → Deal properties
2. Click "Create property"
3. Fill in:
   - Label: Insurance Reply Received
   - Internal name: insurance_reply_received  ← must match exactly
   - Field type: Single checkbox
4. Save

---

### Step 3 — Deploy to Render (free)

1. Push this folder to a new GitHub repo (github.com → New repository)
2. Go to https://render.com and sign up with your GitHub account
3. Click "New" → "Web Service"
4. Connect your GitHub repo
5. Fill in:
   - Name: campo-reply-parser
   - Runtime: Node
   - Build command: npm install
   - Start command: npm start
6. Under "Environment Variables" add:
   - ANTHROPIC_API_KEY = your key from Step 1
   - HUBSPOT_API_KEY = your token from Step 1
   - WEBHOOK_SECRET = any random string you make up
7. Click "Create Web Service"
8. Wait ~2 minutes. Render gives you a URL like: https://campo-reply-parser.onrender.com

Your webhook endpoint is:
  https://campo-reply-parser.onrender.com/api/campo-reply-parser

---

### Step 4 — Set up the HubSpot Workflow

1. Go to Automation → Workflows → Create Workflow → Deal-based
2. Name it: Insurance Claim Follow-Up
3. Trigger: Deal property "Insurance Estimate Sent Date" is known
4. Add steps (repeat until you hit the limit):

   [Delay] 7 days
   [If/Then Branch]
     - insurance_reply_received = true → Unenroll
     - No (default) → Create Task (assign to deal owner, "Send follow-up email to insurance company")
   [Delay] 7 days
   [If/Then Branch]
     ...repeat...

5. Turn on the workflow

---

### Step 5 — Set up the HubSpot Webhook on inbound email

1. In HubSpot go to Settings → Integrations → Webhooks (or use a Workflow with a webhook action)
2. Since HubSpot Professional uses Workflow webhooks (not native inbox webhooks), do this:

   In your inbox conversation view, create a second simple workflow:
   - Object: Conversations
   - Trigger: Conversation created in "Insurance Claims" inbox
   - Action: Send a webhook (POST) to your Render URL
   - Request body (use tokens):
     {
       "from": "{{conversation.latest_message.sender_email}}",
       "subject": "{{conversation.subject}}",
       "body": "{{conversation.latest_message.body}}",
       "deal_id": "{{conversation.associated_deal.id}}"
     }

3. Save and turn on

---

## Testing it locally

```bash
npm install
cp .env.example .env
# fill in your keys in .env
npm run dev

# In another terminal:
curl -X POST http://localhost:3000/api/campo-reply-parser \
  -H "Content-Type: application/json" \
  -d '{
    "from": "noreply@allstate.com",
    "subject": "Auto-Reply: Claim received",
    "body": "This is an automated acknowledgment. A representative will contact you within 3-5 business days.",
    "deal_id": "12345"
  }'
```

Expected response:
```json
{
  "deal_id": "12345",
  "verdict": "AUTOMATED",
  "confidence": "high",
  "reasoning": "The email is a standard auto-acknowledgment with no human-authored content.",
  "hubspot_updated": false
}
```

---

## Troubleshooting

- **HubSpot property not updating**: Double-check the internal name is exactly `insurance_reply_received`
- **Render service sleeping**: Free tier sleeps after 15min inactivity. Upgrade to the $7/mo plan for always-on, or use Railway.app instead
- **deal_id missing**: Make sure the conversation in HubSpot is associated with a Deal before the webhook fires
