// SMART Advanced Consulting - Discovery Form Backend
// Receives form submissions, sends email notification, creates Asana task
// Hosted on Render as a Web Service (Node runtime, free tier)
//
// NOTE: Email is sent via the Resend HTTP API rather than SMTP.
// Render blocks outbound traffic on SMTP ports (25, 465, 587) on free web
// services, so a direct SMTP connection (e.g. via nodemailer) will always
// time out on that tier. Resend sends over standard HTTPS (port 443),
// which is not affected.

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const ASANA_TOKEN = (process.env.ASANA_TOKEN || '').trim();
const ASANA_PROJECT_ID = (process.env.ASANA_PROJECT_ID || '').trim();
const NOTIFY_EMAIL = (process.env.NOTIFY_EMAIL || '').trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const FROM_EMAIL = (process.env.FROM_EMAIL || '').trim();

// ── LABELS ──────────────────────────────────────────────────────────────────

const Q1_LABELS = {
  '0':  'Not using Asana yet / just getting started',
  '1':  'Using Asana but messy or inconsistent',
  '2':  'Some workflows exist but need proper design',
  '3':  'Working system, needs to work across multiple teams',
  '9':  'Stable governed system, ready for AI',
  '-1': 'Not sure where we sit'
};

const Q2_LABELS = {
  client_delivery:  'Client project and service delivery',
  internal_ops:     'Internal operations and shared services',
  product_campaign: 'Product and campaign work',
  regulated:        'Regulated or compliance-driven processes',
  mixed:            'Mixed client-facing and internal work'
};

const Q3_LABELS = { '1': '1-10 people', '2': '11-30 people', '3': '31-75 people', '4': '76 or more' };
const Q4_LABELS = { '1': 'Just one team', '2': 'Two to three teams', '3': 'Four or more teams', '0': 'Not sure yet' };
const Q5_LABELS = {
  '0': 'No, work stays within one team',
  '1': 'Occasionally, some things move across teams',
  '2': 'Yes, regularly',
  '3': 'Yes, and broken handoffs are one of our main problems'
};

const Q6_LABELS = {
  timebound:   'Time-bound projects with deadlines and milestones',
  ongoing:     'Ongoing or repeating operations',
  campaigns:   'Campaigns or launches',
  intake:      'Intake and request management',
  approvals:   'Approvals and review processes',
  sops:        'SOPs, documentation, or reference material',
  client_info: 'Client or product information management'
};

const Q7_LABELS = { '1': 'One', '2': 'Two to three', '3': 'Four or more', '0': 'Not sure yet' };
const Q8_LABELS = { '1': 'Simple', '2': 'Moderate', '3': 'Complex', '4': 'Very complex' };

const Q9_LABELS = {
  visibility:   'No visibility into what is happening',
  ownership:    'Unclear ownership',
  handoffs:     'Broken handoffs',
  scattered:    'Work scattered across too many tools',
  inconsistency:'Inconsistent processes',
  adoption:     'Low adoption',
  reporting:    'Manual or unreliable reporting',
  manual:       'Too much manual work'
};

const Q10_LABELS = {
  slack: 'Slack / Teams', sheets: 'Spreadsheets (Excel / Google Sheets)',
  email: 'Email for task tracking', monday: 'Monday.com / Trello',
  jira: 'Jira / Notion', crm: 'CRM (Salesforce, HubSpot, etc.)',
  drive: 'Google Drive / SharePoint', other: 'Other tools'
};

const Q11_LABELS = {
  dashboards: 'Dashboards or leadership reporting',
  automation: 'Automations and rules',
  migration:  'Migration from another tool',
  training:   'Team adoption and training',
  lead:       'Internal Asana owner or champion',
  support:    'Ongoing support after setup',
  ai:         'AI readiness or AI workflow setup'
};

const Q12_LABELS = {
  guided: 'Build it together (Guided Build)',
  dfy:    'Build it for us (Done-for-You)',
  mix:    'A mix of both',
  unsure: 'Not sure'
};

// ── HELPERS ──────────────────────────────────────────────────────────────────

function labelMulti(values, labelMap) {
  if (!values || values.length === 0) return 'None selected';
  return values.map(v => labelMap[v] || v).join(', ');
}

function label(value, labelMap) {
  return labelMap[String(value)] || String(value) || 'Not answered';
}

// ── AGENDA BUILDER ───────────────────────────────────────────────────────────

function buildAgenda(data) {
  const pkg = data.package || 'TBC';
  const depth = data.depth || 'TBC';
  const painPoints = (data.q9 || []).map(v => Q9_LABELS[v] || v);
  const workTypes = (data.q6 || []).map(v => Q6_LABELS[v] || v);
  const tools = (data.q10 || []).map(v => Q10_LABELS[v] || v);
  const addOns = (data.q11 || []).map(v => Q11_LABELS[v] || v);

  const lines = [];
  lines.push(`FIRST MEETING AGENDA`);
  lines.push(`Recommended package: ${pkg} (${depth} depth)`);
  lines.push(``);
  lines.push(`CLIENT DETAILS`);
  lines.push(`   Company: ${data.clientCompany || 'Not provided'}`);
  lines.push(`   Contact: ${data.clientContact || 'Not provided'}`);
  lines.push(`   Email: ${data.clientEmail || 'Not provided'}`);
  if (data.clientWebsite) lines.push(`   Website: ${data.clientWebsite}`);
  if (data.clientAddress) lines.push(`   Address: ${data.clientAddress}`);
  if (data.clientCountry) lines.push(`   Country: ${data.clientCountry}`);
  lines.push(``);
  lines.push(`1. OPEN - confirm understanding of their situation`);
  lines.push(`   Context from form: ${label(data.q1, Q1_LABELS)}`);
  lines.push(`   Business type: ${label(data.q2, Q2_LABELS)}`);
  lines.push(``);
  lines.push(`2. CLARIFY PAIN POINTS (they flagged these)`);
  if (painPoints.length > 0) {
    painPoints.forEach(p => lines.push(`   - ${p}`));
  } else {
    lines.push(`   - No specific pain points selected`);
  }
  lines.push(``);
  lines.push(`3. UNDERSTAND THEIR WORK`);
  lines.push(`   Team size: ${label(data.q3, Q3_LABELS)}`);
  lines.push(`   Teams involved: ${label(data.q4, Q4_LABELS)}`);
  lines.push(`   Cross-team flow: ${label(data.q5, Q5_LABELS)}`);
  lines.push(`   Work types: ${workTypes.length > 0 ? workTypes.join(', ') : 'Not specified'}`);
  lines.push(`   Workflow count: ${label(data.q7, Q7_LABELS)}`);
  lines.push(`   Complexity: ${label(data.q8, Q8_LABELS)}`);
  lines.push(``);
  lines.push(`4. CURRENT STACK`);
  lines.push(`   Tools in use: ${tools.length > 0 ? tools.join(', ') : 'Not specified'}`);
  lines.push(``);
  lines.push(`5. PRESENT RECOMMENDATION`);
  lines.push(`   Package: SMART ${pkg}`);
  lines.push(`   Depth: ${depth}`);
  lines.push(`   Delivery mode preference: ${label(data.q12, Q12_LABELS)}`);
  if (addOns.length > 0) lines.push(`   Add-ons flagged: ${addOns.join(', ')}`);
  lines.push(``);
  lines.push(`6. WHAT THEY SAID`);
  if (data.successText) lines.push(`   Success looks like: "${data.successText}"`);
  if (data.problemText) lines.push(`   Main problem: "${data.problemText}"`);
  lines.push(``);
  lines.push(`7. CLARIFYING QUESTIONS FOR THIS CALL`);
  if (data.q2 === 'regulated') lines.push(`   - What compliance or audit requirements need to be factored into workflow design?`);
  if ((data.q9 || []).includes('adoption')) lines.push(`   - What has caused low adoption so far? Is it the tool, the setup, or the culture?`);
  if ((data.q9 || []).includes('handoffs')) lines.push(`   - Walk me through a specific handoff that broke recently. What should have happened?`);
  if ((data.q9 || []).includes('visibility')) lines.push(`   - Who specifically needs visibility? What decisions are they trying to make?`);
  if ((data.q6 || []).includes('client_info')) lines.push(`   - What client or product data are you currently storing, and where does it live?`);
  if ((data.q6 || []).includes('approvals')) lines.push(`   - How many approval stages are typical? Who are the approvers and what triggers each stage?`);
  if ((data.q11 || []).includes('migration')) lines.push(`   - What tool or data are you migrating from? How much historical data needs to move?`);
  if ((data.q11 || []).includes('ai')) lines.push(`   - What specifically interests you about Asana AI? What tasks or decisions would you want it to help with?`);
  lines.push(`   - What would make this engagement a success for you personally?`);
  lines.push(`   - Who else from your team should be involved in the build or decisions?`);
  lines.push(``);
  lines.push(`8. NEXT STEPS`);
  lines.push(`   - Confirm package and scope`);
  lines.push(`   - Agree on engagement start date`);
  lines.push(`   - Send proposal / SOW`);

  return lines.join('\n');
}

// ── SUBMISSION SUMMARY (shared by email body and PDF) ────────────────────────

function buildSummaryText(data) {
  return `
CLIENT DETAILS
Company: ${data.clientCompany || 'Not provided'}
Contact: ${data.clientContact || 'Not provided'}
Email: ${data.clientEmail || 'Not provided'}${data.clientWebsite ? `\nWebsite: ${data.clientWebsite}` : ''}${data.clientAddress ? `\nAddress: ${data.clientAddress}` : ''}${data.clientCountry ? `\nCountry: ${data.clientCountry}` : ''}

RECOMMENDATION
Package: SMART ${data.package || 'TBC'}
Depth: ${data.depth || 'TBC'}
Delivery preference: ${label(data.q12, Q12_LABELS)}

ABOUT THE CLIENT
Asana situation: ${label(data.q1, Q1_LABELS)}
Business type: ${label(data.q2, Q2_LABELS)}
Team size: ${label(data.q3, Q3_LABELS)}
Teams involved: ${label(data.q4, Q4_LABELS)}
Cross-team flow: ${label(data.q5, Q5_LABELS)}

WORKFLOWS
Work types: ${labelMulti(data.q6, Q6_LABELS)}
Workflow count: ${label(data.q7, Q7_LABELS)}
Complexity: ${label(data.q8, Q8_LABELS)}

PAIN POINTS
${labelMulti(data.q9, Q9_LABELS)}

TOOLS IN USE
${labelMulti(data.q10, Q10_LABELS)}

PRIORITIES AND ADD-ONS
${labelMulti(data.q11, Q11_LABELS)}

WHAT THEY SAID
Success looks like: ${data.successText || '(not provided)'}
Main problem: ${data.problemText || '(not provided)'}
  `.trim();
}

function safeFileSlug(text) {
  return String(text || 'submission')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

// ── EMAIL (via Resend HTTP API) ──────────────────────────────────────────────

function sendEmail(data) {
  return new Promise((resolve, reject) => {
    if (!RESEND_API_KEY) return reject(new Error('RESEND_API_KEY environment variable is not set'));
    if (!FROM_EMAIL) return reject(new Error('FROM_EMAIL environment variable is not set'));
    if (!NOTIFY_EMAIL) return reject(new Error('NOTIFY_EMAIL environment variable is not set'));

    const companyPart = data.clientCompany ? `${data.clientCompany} - ` : '';
    const subject = `New SMART Discovery Form: ${companyPart}${label(data.q2, Q2_LABELS)} - ${data.package || 'TBC'} ${data.depth || ''}`;

    const body = `
New discovery form submission received.

${buildSummaryText(data)}

---
An Asana task has been created with a first meeting agenda. A PDF copy of this submission is attached to that task.
    `.trim();

    const payload = JSON.stringify({
      from: FROM_EMAIL,
      to: [NOTIFY_EMAIL],
      subject,
      text: body
    });

    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => { responseData += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(responseData));
        } else {
          reject(new Error(`Resend API error ${res.statusCode}: ${responseData}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── ASANA TASK ───────────────────────────────────────────────────────────────

function createAsanaTask(data) {
  return new Promise((resolve, reject) => {
    if (!ASANA_TOKEN) return reject(new Error('ASANA_TOKEN environment variable is not set'));
    if (!ASANA_PROJECT_ID) return reject(new Error('ASANA_PROJECT_ID environment variable is not set or is empty'));

    const agenda = buildAgenda(data);
    const companyPart = data.clientCompany ? `${data.clientCompany} | ` : '';
    const taskName = `Discovery: ${companyPart}${label(data.q2, Q2_LABELS)} | SMART ${data.package || 'TBC'} ${data.depth || ''}`;

    const body = JSON.stringify({
      data: {
        name: taskName,
        notes: agenda,
        projects: [ASANA_PROJECT_ID]
      }
    });

    const options = {
      hostname: 'app.asana.com',
      path: '/api/1.0/tasks',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ASANA_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => { responseData += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(responseData));
        } else {
          reject(new Error(`Asana API error ${res.statusCode}: ${responseData}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── PDF SUMMARY ──────────────────────────────────────────────────────────────

function buildPdfBuffer(data) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('SMART Discovery Form Submission', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#666666')
      .text(`Recommended: SMART ${data.package || 'TBC'} (${data.depth || 'TBC'} depth)`);
    doc.moveDown();
    doc.fillColor('#000000').fontSize(10).text(buildSummaryText(data));

    doc.end();
  });
}

// ── ASANA ATTACHMENT UPLOAD ──────────────────────────────────────────────────

function uploadAsanaAttachment(taskGid, pdfBuffer, filename) {
  const FormData = require('form-data');
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', pdfBuffer, { filename, contentType: 'application/pdf' });

    const headers = form.getHeaders();
    headers['Authorization'] = `Bearer ${ASANA_TOKEN}`;

    const req = https.request({
      hostname: 'app.asana.com',
      path: `/api/1.0/tasks/${taskGid}/attachments`,
      method: 'POST',
      headers
    }, (res) => {
      let responseData = '';
      res.on('data', chunk => { responseData += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(responseData));
        } else {
          reject(new Error(`Asana attachment error ${res.statusCode}: ${responseData}`));
        }
      });
    });

    req.on('error', reject);
    form.pipe(req);
  });
}

// ── SERVER ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS headers so the form page can call this backend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/submit') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        console.log(`Submission received: SMART ${data.package} ${data.depth}`);

        // Email runs independently. Asana task creation must finish before the
        // PDF can be attached to it, so that step is chained rather than parallel.
        const asanaWithAttachment = (async () => {
          const task = await createAsanaTask(data);
          try {
            let pdfBuffer;
            let source;
            if (data.pdfBase64) {
              pdfBuffer = Buffer.from(data.pdfBase64, 'base64');
              source = 'client-rendered snapshot';
            } else {
              pdfBuffer = await buildPdfBuffer(data);
              source = 'server-generated fallback';
            }
            const filename = `SMART-Discovery-${safeFileSlug(data.package)}-${safeFileSlug(label(data.q2, Q2_LABELS))}.pdf`;
            await uploadAsanaAttachment(task.data.gid, pdfBuffer, filename);
            console.log(`PDF attachment success (${source})`);
          } catch (attachErr) {
            console.error('PDF attachment failed:', attachErr.message);
          }
          return task;
        })();

        const results = await Promise.allSettled([
          sendEmail(data),
          asanaWithAttachment
        ]);

        results.forEach((result, i) => {
          const name = i === 0 ? 'Email' : 'Asana';
          if (result.status === 'rejected') {
            console.error(`${name} failed:`, result.reason.message);
          } else {
            console.log(`${name} success`);
          }
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

      } catch (err) {
        console.error('Submission error:', err.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SMART Form Backend running.');
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`SMART Form Backend listening on port ${PORT}`);
});
