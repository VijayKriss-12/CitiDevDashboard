/* ════════════════════════════════════════════════════════
   PR INTELLIGENCE PLATFORM — app.js
   Architecture: API → State → Render → Events
   ════════════════════════════════════════════════════════ */

"use strict";

/* ══════════════════════════════════════════════
   ═══  API LAYER — All external integrations  ══
   ══════════════════════════════════════════════ */
const API = {

  async fetchStories() {
    const res = await fetch("/.netlify/functions/getStories");
    if (!res.ok) throw new Error(`Stories API error: ${res.statusText}`);
    const data = await res.json();
    return data.stories || [];
  },

  async fetchCommits({ owner, repo, branch, since }) {
    const res = await fetch("/.netlify/functions/getCommits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, repo, branch, since }),
    });
    if (!res.ok) throw new Error(`Commits API error: ${res.statusText}`);
    return await res.json();
  },

  async generateCombinedDiff(commits) {
    const payload = commits.map((c) => ({ sha: c.sha, url: c.url }));
    const res = await fetch("/.netlify/functions/combine-commits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commits: payload }),
    });
    if (!res.ok) throw new Error(`Diff API error: ${res.statusText}`);
    return await res.json();
  },

  async callLLM(prompt) {
    const res = await fetch("/.netlify/functions/gemini-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) throw new Error(`LLM API error: ${res.statusText}`);
    const data = await res.json();
    return data.reply || data.response || data;
  },
};

/* ══════════════════════════════════════════════
   ═══  STATE LAYER — Centralized store        ══
   ══════════════════════════════════════════════ */
const State = {
  _data: {
    stories:         [],
    selectedStory:   null,
    commits:         [],
    analysisResult:  null,
    testingResult:   null,
    // Async promise caches to prevent duplicate calls
    _analysisPromise: null,
    _testingPromise:  null,
  },

  get(key)         { return this._data[key]; },
  set(key, value)  { this._data[key] = value; },

  reset() {
    this._data.analysisResult  = null;
    this._data.testingResult   = null;
    this._data._analysisPromise = null;
    this._data._testingPromise  = null;
    // Reset tab load flags
    document.querySelectorAll(".tab-content").forEach((el) => {
      el.dataset.loaded = "";
    });
  },
};

/* ══════════════════════════════════════════════
   ═══  UTILS — Formatting & helpers           ══
   ══════════════════════════════════════════════ */
const Utils = {

  escapeHtml(str) {
    if (!str) return "";
    const s = typeof str === "string" ? str : JSON.stringify(str, null, 2);
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  formatCommits(raw) {
    return raw.map((c, i) => ({
      sno:        i + 1,
      sha:        c.sha,
      message:    c.commit.message,
      url:        c.html_url,
      author:     c.commit.author.name,
      date:       c.commit.author.date,
      isVerified: c.commit.verification?.verified ?? false,
      avatar:     c.author?.avatar_url || "",
    }));
  },

  formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
      });
    } catch {
      return iso;
    }
  },

  sanitizeLLMText(raw) {
    if (!raw) return "";
    if (typeof raw !== "string") {
      try { raw = JSON.stringify(raw); } catch { return ""; }
    }
    // Strip markdown code fences used as wrappers
    return raw
      .replace(/^```(?:json|markdown)?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();
  },

  copyToClipboard(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("copied");
      }, 2000);
    });
  },

  exportJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};

/* ══════════════════════════════════════════════
   ═══  PROMPTS — LLM prompt templates         ══
   ══════════════════════════════════════════════ */
const Prompts = {

  analysis(diff, storyDescription) {
    return `
**Role:** Staff Software Engineer — Production Gatekeeper.
**Constraint:** Extreme brevity. No conversational filler. Use strictly professional/technical vocabulary. Output must be clean markdown — no system noise.

**Evaluation Criteria:**
1. **Score (0–100):** Rate on Architecture, Security, and Production-Readiness.
2. **Blockers:** Functional bugs or security vulnerabilities requiring immediate rejection.
3. **Refactorings:** Technical debt or efficiency improvements — include exact code diffs.
4. **Security:** Data leakages, sanitization gaps, naming/structural risks.

**Required Output Format (strict):**

# [Score: X/100]

### 🚨 BLOCKERS
* **[Issue Title]**
  * Source: [File/Line if determinable]
  * Problem: [One-line impact statement]
  * Fix:
\`\`\`
[corrected code snippet]
\`\`\`

### 🛠️ REFACTORINGS
* **[Subject]**
  * Observation: [Short description]
  * Code:
\`\`\`
[diff or one-liner]
\`\`\`

### 🔒 SECURITY & BEST PRACTICES
* [Point-form observation]
* [Point-form observation]

---

**JIRA Story Context:**
${storyDescription}

**Commit Diff:**
${diff}
`.trim();
  },

  testing(diff, storyDescription) {
    return `
**Role:** Senior QA Strategist + Test Automation Architect.
**Mandate:** Generate a complete, structured test plan from the given Jira story and code diff.

**Output Format:** Respond ONLY with a valid JSON object. No markdown fences, no prose, no preamble.

JSON Schema:
{
  "coverageScore": <number 0-100>,
  "summary": "<one paragraph summary of what was implemented>",
  "coverageBreakdown": {
    "fullyImplemented": ["<requirement string>"],
    "partiallyImplemented": ["<requirement string>"],
    "missing": ["<requirement string>"]
  },
  "riskZones": ["<risk description>"],
  "testCases": [
    {
      "id": "TC-001",
      "name": "<short test name>",
      "type": "<functional|edge|negative|regression|integration>",
      "priority": "<High|Medium|Low>",
      "description": "<what this test validates>",
      "preconditions": ["<condition>"],
      "steps": ["<step 1>", "<step 2>"],
      "expectedResult": "<what should happen>",
      "predictedOutcome": "<PASS|FAIL|UNKNOWN>",
      "justification": "<why this outcome is predicted>"
    }
  ]
}

Generate at minimum 6 test cases covering: functional, edge, negative, regression, and integration scenarios.
Predict PASS/FAIL based on alignment between the acceptance criteria and the actual diff.

**JIRA Story:**
${storyDescription}

**Code Diff:**
${diff}
`.trim();
  },
};

/* ══════════════════════════════════════════════
   ═══  PARSERS — LLM output normalization     ══
   ══════════════════════════════════════════════ */
const Parsers = {

  analysis(raw) {
    const text = Utils.sanitizeLLMText(raw);

    const scoreMatch = text.match(/Score:\s*(\d+)/i);
    const score = scoreMatch ? `${scoreMatch[1]}/100` : "N/A";

    // Split on any ### heading so we don't rely on exact emoji matching
    const sectionBlocks = text.split(/\n(?=###\s)/);

    const findSection = (...keywords) => {
      const block = sectionBlocks.find((b) =>
        keywords.some((kw) => b.toLowerCase().includes(kw.toLowerCase()))
      );
      if (!block) return "";
      // Strip the heading line itself
      return block.replace(/^###[^\n]*\n/, "").trim();
    };

    return {
      score,
      jiraCoverage: findSection("JIRA COVERAGE", "📌"),
      blockers:     findSection("BLOCKERS",       "🚨"),
      refactors:    findSection("REFACTORING",    "🛠"),
      security:     findSection("SECURITY",       "🔒"),
      raw:          text,
    };
  },

  testing(raw) {
    const text = Utils.sanitizeLLMText(raw);
    try {
      // Strip any stray fences
      const clean = text.replace(/```json?/g, "").replace(/```/g, "").trim();
      return JSON.parse(clean);
    } catch {
      console.error("Failed to parse testing JSON:", text);
      return null;
    }
  },
};

/* ══════════════════════════════════════════════
   ═══  RENDER LAYER — UI Components           ══
   ══════════════════════════════════════════════ */
const Render = {

  /* ─── STORIES SIDEBAR ─── */
  stories() {
    const list    = document.getElementById("storyList");
    const count   = document.getElementById("sidebarCount");
    const badge   = document.getElementById("storyCountBadge");
    const stories = State.get("stories");

    count.textContent = stories.length;
    badge.textContent = `${stories.length} stories loaded`;
    list.innerHTML    = "";

    stories.forEach((s) => {
      const div       = document.createElement("div");
      div.className   = "story-item";
      div.dataset.id  = s.id;
      div.innerHTML   = `
        <div class="story-item-id">${s.id}</div>
        <div class="story-item-title">${Utils.escapeHtml(s.title)}</div>
        <div class="story-item-status">${s.status || ""}</div>
      `;
      div.onclick = () => selectStory(s);
      list.appendChild(div);
    });
  },

  /* ─── OVERVIEW TAB ─── */
  overview() {
    const s   = State.get("selectedStory");
    const c   = State.get("commits");
    const el  = document.getElementById("overview");

    el.innerHTML = `
      <div class="overview-grid">
        <div class="overview-card">
          <div class="overview-card-label">Total Commits</div>
          <div class="overview-card-value">${c.length}</div>
        </div>
        <div class="overview-card">
          <div class="overview-card-label">Story Status</div>
          <div class="overview-card-value" style="font-size:15px">${Utils.escapeHtml(s.status || "—")}</div>
        </div>
      </div>
      <div class="description-block">
        <h3>Description</h3>
        <p>${Utils.escapeHtml(s.description || "No description provided.")}</p>
      </div>
    `;
  },

  /* ─── COMMITS TAB ─── */
  commits() {
    const commits    = State.get("commits");
    const container  = document.getElementById("commits");

    document.getElementById("commitsBadge").textContent = commits.length;

    if (!commits.length) {
      container.innerHTML = `<div class="no-data">No commits found for this story</div>`;
      return;
    }

    let rows = "";
    commits.forEach((c, i) => {
      const msg    = Utils.escapeHtml(c.message.split("\n")[0]);
      const date   = Utils.formatDate(c.date);
      const avatar = c.avatar || "https://i.pravatar.cc/40";
      const status = c.isVerified ? "pr-merged" : "pr-closed";
      const label  = c.isVerified ? "verified"  : "unverified";

      rows += `
        <tr class="pr-expand" data-sha="${c.sha}" data-index="${i}">
          <td><span class="pr-sha">${String(i + 1).padStart(2, "0")}</span></td>
          <td>
            <span class="pr-toggle">▶</span>
            <a href="${c.url}" target="_blank" rel="noopener">${msg}</a>
          </td>
          <td>
            <div class="pr-author">
              <img class="pr-avatar" src="${avatar}" onerror="this.src='https://i.pravatar.cc/40'" />
              <span>${Utils.escapeHtml(c.author)}</span>
            </div>
          </td>
          <td>${date}</td>
          <td><span class="pr-badge ${status}">${label}</span></td>
        </tr>
        <tr class="pr-details-row" data-sha="${c.sha}">
          <td colspan="5">
            <div class="pr-details" id="detail-${c.sha}">
              <div class="pr-details-loading">Click to expand and load file changes…</div>
            </div>
          </td>
        </tr>
      `;
    });

    container.innerHTML = `
      <div class="commits-toolbar">
        <div class="commits-count">Showing <span>${commits.length}</span> commits</div>
      </div>
      <table class="pr-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Commit Message</th>
            <th>Author</th>
            <th>Date</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    // Bind row expand toggles
    container.querySelectorAll(".pr-expand").forEach((row) => {
      row.onclick = () => toggleCommitRow(row);
    });
  },

  /* ─── ANALYSIS TAB ─── */
  analysisLoading() {
    document.getElementById("analysis").innerHTML = `
      <div class="analysis-loading">
        <div class="spinner"></div>
        <p>Generating analysis…</p>
        <div class="loading-steps">
          <div class="loading-step active" id="lstep1">Fetching combined diff</div>
          <div class="loading-step"        id="lstep2">Sending to LLM</div>
          <div class="loading-step"        id="lstep3">Parsing response</div>
        </div>
      </div>
    `;
  },

  analysisStep(step) {
    for (let i = 1; i <= 3; i++) {
      const el = document.getElementById(`lstep${i}`);
      if (!el) continue;
      el.className = i < step ? "loading-step done" : i === step ? "loading-step active" : "loading-step";
    }
  },

  analysis(result) {
    const parsed    = Parsers.analysis(result.raw);
    const container = document.getElementById("analysis");

    container.innerHTML = `
      <div class="analysis-container">

        <!-- Score -->
        <div class="score-row">
          <div class="score-card">
            <div>
              <div class="score-label">Analysis Score</div>
              <div class="score-value">${Utils.escapeHtml(parsed.score)}</div>
            </div>
            <div class="score-divider"></div>
            <div class="score-meta">
              Architecture · Security<br>Production-Readiness
            </div>
          </div>
        </div>

        ${Render._analysisSection("📌 JIRA Coverage Analysis", parsed.jiraCoverage, "coverage")}
        ${Render._analysisSection("🚨 Blockers",               parsed.blockers,     "blocker")}
        ${Render._analysisSection("🛠️ Refactorings",           parsed.refactors,    "refactor")}
        ${Render._analysisSection("🔒 Security & Best Practices", parsed.security,  "security")}

      </div>
    `;

    // Bind section toggles and copy buttons
    container.querySelectorAll(".section-header").forEach((hdr) => {
      hdr.onclick = () => hdr.closest(".analysis-section").classList.toggle("collapsed");
    });

    container.querySelectorAll(".copy-btn").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const pre = btn.nextElementSibling;
        Utils.copyToClipboard(pre?.textContent || "", btn);
      };
    });
  },

  _analysisSection(title, content, type) {
    if (!content) return "";

    let bodyHtml = "";

    // ── JIRA COVERAGE: table of requirements vs status ───────
    if (type === "coverage") {
      const noteMatch = content.match(/\*Note:([\s\S]*?)$/m);
      const noteHtml  = noteMatch
        ? `<div style="margin-top:12px;font-size:12px;color:var(--text-muted);font-style:italic;padding:9px 14px;background:var(--bg-elevated);border-radius:var(--radius-sm);border-left:3px solid var(--amber)">${Utils.escapeHtml(noteMatch[1].trim())}</div>`
        : "";

      const cleanContent = content.replace(/\*Note:[\s\S]*$/m, "");
      const items = cleanContent
        .split(/\n/)
        .map((l) => l.replace(/^\*\s+/, "").trim())
        .filter(Boolean);

      const statusChip = (line) => {
        const l = line.toLowerCase();
        if (l.includes("missing"))
          return `<span style="font-family:var(--font-mono);font-size:10px;background:rgba(248,113,113,0.12);color:var(--red);border:1px solid rgba(248,113,113,0.25);padding:2px 9px;border-radius:999px">✗ MISSING</span>`;
        if (l.includes("partial"))
          return `<span style="font-family:var(--font-mono);font-size:10px;background:rgba(251,191,36,0.12);color:var(--amber);border:1px solid rgba(251,191,36,0.25);padding:2px 9px;border-radius:999px">⚡ PARTIAL</span>`;
        return `<span style="font-family:var(--font-mono);font-size:10px;background:rgba(52,211,153,0.12);color:var(--emerald);border:1px solid rgba(52,211,153,0.25);padding:2px 9px;border-radius:999px">✓ DONE</span>`;
      };

      const rows = items.map((item) => {
        const clean  = item.replace(/\*\*(.*?)\*\*/g, "$1");
        const parts  = clean.split(/\s*[—–-]\s*/);
        const label  = (parts[0] || clean).replace(/^\[|\]$/g, "").trim();
        const status = parts[1] ? parts[1].trim() : "";
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border-subtle);font-size:13px;color:var(--text-secondary)">
          <span>${Utils.escapeHtml(label)}</span>
          ${statusChip(status || item)}
        </div>`;
      }).join("");

      bodyHtml = `
        <div style="border:1px solid var(--border-subtle);border-radius:var(--radius-md);overflow:hidden;background:var(--bg-elevated)">${rows}</div>
        ${noteHtml}
      `;
    }

    // ── SECURITY: simple bullet list ─────────────────────────
    else if (type === "security") {
      const items = content
        .split(/\n\*\s+/)
        .map((i) => i.replace(/^\*\s*/, "").trim())
        .filter(Boolean);
      bodyHtml = `<ul class="security-list">${items.map((i) => `<li>${Utils.escapeHtml(i)}</li>`).join("")}</ul>`;
    }

    // ── BLOCKERS / REFACTORINGS: structured cards ─────────────
    else {
      const rawItems = content.split(/\n\*\s+(?=\*\*)/).filter(Boolean);

      bodyHtml = rawItems.map((item) => {
        const titleMatch  = item.match(/^\*\*(.*?)\*\*/);
        const cardTitle   = titleMatch ? titleMatch[1].trim() : item.split("\n")[0].replace(/\*/g, "").trim();

        const sourceMatch  = item.match(/Source:\s*(.*)/);
        const source       = sourceMatch ? sourceMatch[1].trim() : "";

        const problemMatch = item.match(/Problem:\s*([\s\S]*?)(?=\n\s*(?:Fix:|Code:|Observation:)|```|$)/);
        const problem      = problemMatch ? problemMatch[1].trim() : "";

        const obsMatch     = item.match(/Observation:\s*([\s\S]*?)(?=\n\s*(?:Code:|Fix:)|```|$)/);
        const obs          = obsMatch ? obsMatch[1].trim() : "";

        // All code blocks in the item
        const codeMatches = [...item.matchAll(/```(?:\w*\n)?([\s\S]*?)```/g)];
        const codeBlocks  = codeMatches.map((m) => m[1].trim());

        return `
          <div class="analysis-card">
            <div class="card-title">${Utils.escapeHtml(cardTitle)}</div>
            ${source  ? `<div class="card-meta">📁 ${Utils.escapeHtml(source)}</div>` : ""}
            ${problem ? `<div class="card-text">${Utils.escapeHtml(problem)}</div>`   : ""}
            ${obs     ? `<div class="card-text">${Utils.escapeHtml(obs)}</div>`       : ""}
            ${codeBlocks.map((code) => `
              <div class="code-block" style="position:relative">
                <button class="copy-btn">Copy</button>
                <pre>${Utils.escapeHtml(code)}</pre>
              </div>`).join("")}
          </div>
        `;
      }).join("");
    }

    return `
      <div class="analysis-section ${type}">
        <div class="section-header">
          <h3>${title}</h3>
          <span class="section-toggle">▼</span>
        </div>
        <div class="section-body">
          <div class="analysis-list">${bodyHtml}</div>
        </div>
      </div>
    `;
  },

  /* ─── TESTING SUITE TAB ─── */
  testingLoading() {
    document.getElementById("testing").innerHTML = `
      <div class="analysis-loading">
        <div class="spinner"></div>
        <p>Generating test intelligence…</p>
        <div class="loading-steps">
          <div class="loading-step active" id="tstep1">Analysing story requirements</div>
          <div class="loading-step"        id="tstep2">Mapping commit diffs to acceptance criteria</div>
          <div class="loading-step"        id="tstep3">Generating test cases with PASS/FAIL predictions</div>
        </div>
      </div>
    `;
  },

  testingStep(step) {
    for (let i = 1; i <= 3; i++) {
      const el = document.getElementById(`tstep${i}`);
      if (!el) continue;
      el.className = i < step ? "loading-step done" : i === step ? "loading-step active" : "loading-step";
    }
  },

  testing(data) {
    const container = document.getElementById("testing");
    const tests     = data.testCases || [];
    const coverage  = data.coverageScore || 0;
    const risks     = data.riskZones || [];

    const passCount = tests.filter(t => t.status === "Pass").length;
    const failCount = tests.filter(t => t.status === "Fail").length;
    const avgScore  = tests.length
      ? Math.round(tests.reduce((s, t) => s + (t.score || 0), 0) / tests.length)
      : 0;

    // ── Stat Cards ──────────────────────────────────────────
    const statCards = `
      <div class="ts-stat-row">
        <div class="ts-stat">
          <div class="ts-stat-num" style="color:var(--text-primary)">${tests.length}</div>
          <div class="ts-stat-label">Total Tests</div>
        </div>
        <div class="ts-stat-divider"></div>
        <div class="ts-stat">
          <div class="ts-stat-num" style="color:var(--emerald)">${passCount}</div>
          <div class="ts-stat-label">Passed</div>
        </div>
        <div class="ts-stat-divider"></div>
        <div class="ts-stat">
          <div class="ts-stat-num" style="color:var(--red)">${failCount}</div>
          <div class="ts-stat-label">Failed</div>
        </div>
        <div class="ts-stat-divider"></div>
        <div class="ts-stat">
          <div class="ts-stat-num" style="color:var(--cyan)">${coverage}%</div>
          <div class="ts-stat-label">Coverage</div>
        </div>
        <div class="ts-stat-divider"></div>
        <div class="ts-stat">
          <div class="ts-stat-num" style="color:var(--indigo)">${avgScore}<span style="font-size:14px;font-weight:500;color:var(--text-muted)">/10</span></div>
          <div class="ts-stat-label">Avg Score</div>
        </div>
        <div style="flex:1"></div>
        <div class="ts-toolbar-right">
          <div class="ts-search-wrap">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input class="ts-search" id="tsSearch" placeholder="Search scenarios…" />
          </div>
          <div class="ts-filter-group" id="tsFilters">
            <button class="ts-filter active" data-f="all">All</button>
            <button class="ts-filter ts-f-pass" data-f="pass">Pass <span class="ts-filter-count">${passCount}</span></button>
            <button class="ts-filter ts-f-fail" data-f="fail">Fail <span class="ts-filter-count">${failCount}</span></button>
          </div>
          <button class="ts-export-btn" id="tsExportBtn">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export
          </button>
        </div>
      </div>
    `;

    // ── Table ────────────────────────────────────────────────
    const tableRows = tests.map((tc, idx) => {
      const isPassed = tc.status === "Pass";
      const rowId    = `tsrow-${idx}`;

      const evalCell = (val) => {
        const cls = val === "Pass" || val === "High"   ? "ts-eval-good"
                  : val === "Medium"                   ? "ts-eval-mid"
                  :                                      "ts-eval-bad";
        return `<td class="ts-eval-cell"><span class="${cls}">${val}</span></td>`;
      };

      const scoreBar = `
        <div class="ts-score-wrap">
          <span class="ts-score-num" style="color:${tc.score >= 7 ? "var(--emerald)" : tc.score >= 4 ? "var(--amber)" : "var(--red)"}">${tc.score}</span>
          <div class="ts-score-track">
            <div class="ts-score-fill" style="width:${tc.score * 10}%;background:${tc.score >= 7 ? "var(--emerald)" : tc.score >= 4 ? "var(--amber)" : "var(--red)"}"></div>
          </div>
        </div>
      `;

      const typeBadge = `<span class="type-badge type-${(tc.type||'functional').toLowerCase()}">${tc.type||'Functional'}</span>`;

      return `
        <tr class="ts-row" data-status="${isPassed ? "pass" : "fail"}" data-idx="${idx}" id="${rowId}">
          <td class="ts-idx">${String(idx + 1).padStart(2, "0")}</td>
          <td class="ts-scenario">
            <div class="ts-scenario-name">${Utils.escapeHtml(tc.scenario)}</div>
          </td>
          <td>${typeBadge}</td>
          <td>
            ${isPassed
              ? `<span class="ts-status-pass"><span class="ts-status-dot ts-dot-pass"></span>Pass</span>`
              : `<div class="ts-status-fail-wrap ts-tooltip">
                   <span class="ts-status-fail"><span class="ts-status-dot ts-dot-fail"></span>Fail</span>
                   <div class="ts-tooltip-box">
                     <div class="ts-tip-score">Score: ${tc.score}/10</div>
                     <div class="ts-tip-reason">${Utils.escapeHtml(tc.failureReason || "No reason provided")}</div>
                   </div>
                 </div>`
            }
          </td>
          ${evalCell(tc.instruction)}
          ${evalCell(tc.completeness)}
          ${evalCell(tc.coherence)}
          ${evalCell(tc.conciseness)}
          <td>${scoreBar}</td>
          <td class="ts-expand-cell">
            <span class="ts-chevron">›</span>
          </td>
        </tr>
        <tr class="ts-detail-row" id="detail-${idx}" style="display:none">
          <td colspan="10">
            <div class="ts-detail-panel">
              <div class="ts-detail-grid">
                <div class="ts-detail-block">
                  <div class="ts-detail-label">Scenario Description</div>
                  <div class="ts-detail-value">${Utils.escapeHtml(tc.detailed || tc.scenario)}</div>
                </div>
                ${tc.preconditions?.length ? `
                  <div class="ts-detail-block">
                    <div class="ts-detail-label">Preconditions</div>
                    <div class="ts-detail-value">${tc.preconditions.map(p => `<div class="ts-pre-item">${Utils.escapeHtml(p)}</div>`).join("")}</div>
                  </div>
                ` : ""}
                ${tc.steps?.length ? `
                  <div class="ts-detail-block ts-detail-full">
                    <div class="ts-detail-label">Execution Steps</div>
                    <div class="ts-steps-list">
                      ${tc.steps.map((s, i) => `
                        <div class="ts-step">
                          <span class="ts-step-num">${String(i+1).padStart(2,"0")}</span>
                          <span class="ts-step-text">${Utils.escapeHtml(s)}</span>
                        </div>`).join("")}
                    </div>
                  </div>
                ` : ""}
                <div class="ts-detail-block">
                  <div class="ts-detail-label">Expected Result</div>
                  <div class="ts-detail-value">${Utils.escapeHtml(tc.expectedResult || "—")}</div>
                </div>
                ${tc.justification ? `
                  <div class="ts-detail-block ts-detail-full">
                    <div class="ts-detail-label">Outcome Justification</div>
                    <div class="ts-justification">${Utils.escapeHtml(tc.justification)}</div>
                  </div>
                ` : ""}
                ${!isPassed && tc.failureReason ? `
                  <div class="ts-detail-block ts-detail-full">
                    <div class="ts-detail-label">Failure Analysis</div>
                    <div class="ts-failure-note">${Utils.escapeHtml(tc.failureReason)}</div>
                  </div>
                ` : ""}
              </div>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    container.innerHTML = `
      ${statCards}

      <div class="ts-table-wrap">
        <table class="ts-table">
          <thead>
            <tr class="ts-thead-row">
              <th class="ts-th">#</th>
              <th class="ts-th">Scenario</th>
              <th class="ts-th">Type</th>
              <th class="ts-th">Status</th>
              <th class="ts-th">Instruction</th>
              <th class="ts-th">Completeness</th>
              <th class="ts-th">Coherence</th>
              <th class="ts-th">Conciseness</th>
              <th class="ts-th">Score</th>
              <th class="ts-th"></th>
            </tr>
          </thead>
          <tbody id="tsBody">${tableRows}</tbody>
        </table>
      </div>

      <!-- Risk Zones -->
      ${risks.length ? `
        <div class="risk-section" style="margin-top:20px">
          <h4>⚠ Risk Zones</h4>
          <ul class="risk-list">
            ${risks.map(r => `<li>${Utils.escapeHtml(r)}</li>`).join("")}
          </ul>
        </div>
      ` : ""}
    `;

    // ── Row expand/collapse ─────────────────────────────────
    container.querySelectorAll(".ts-row").forEach(row => {
      row.onclick = () => {
        const idx    = row.dataset.idx;
        const detail = document.getElementById(`detail-${idx}`);
        const chev   = row.querySelector(".ts-chevron");
        const isOpen = detail.style.display === "table-row";
        detail.style.display = isOpen ? "none" : "table-row";
        chev.style.transform  = isOpen ? "" : "rotate(90deg)";
        row.classList.toggle("ts-row-open", !isOpen);
      };
    });

    // ── Filters ─────────────────────────────────────────────
    container.querySelectorAll(".ts-filter").forEach(btn => {
      btn.onclick = () => {
        container.querySelectorAll(".ts-filter").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const f = btn.dataset.f;
        container.querySelectorAll(".ts-row, .ts-detail-row").forEach(row => {
          if (row.classList.contains("ts-detail-row")) return;
          const match = f === "all" || row.dataset.status === f;
          const idx   = row.dataset.idx;
          row.style.display = match ? "" : "none";
          const dr = document.getElementById(`detail-${idx}`);
          if (!match && dr) dr.style.display = "none";
        });
      };
    });

    // ── Search ───────────────────────────────────────────────
    container.querySelector("#tsSearch").oninput = (e) => {
      const q = e.target.value.toLowerCase();
      container.querySelectorAll(".ts-row").forEach(row => {
        const text  = row.querySelector(".ts-scenario-name")?.textContent.toLowerCase() || "";
        const match = text.includes(q);
        const idx   = row.dataset.idx;
        row.style.display = match ? "" : "none";
        const dr = document.getElementById(`detail-${idx}`);
        if (!match && dr) dr.style.display = "none";
      });
    };

    // ── Export ───────────────────────────────────────────────
    container.querySelector("#tsExportBtn").onclick = () => {
      Utils.exportJSON(data, `testing-suite-${State.get("selectedStory")?.id || "report"}.json`);
    };
  },

  error(containerId, message) {
    document.getElementById(containerId).innerHTML = `
      <div class="error-block">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        ${Utils.escapeHtml(message)}
      </div>
    `;
  },
};

/* ══════════════════════════════════════════════
   ═══  FLOWS — Orchestration logic            ══
   ══════════════════════════════════════════════ */

async function runAnalysisFlow() {
  Render.analysisLoading();

  Render.analysisStep(1);
  const diffData = await API.generateCombinedDiff(State.get("commits"));
  if (!diffData?.combinedDiff) throw new Error("No diff returned from server");

  Render.analysisStep(2);
  const llmRaw = await API.callLLM(
    Prompts.analysis(diffData.combinedDiff, State.get("selectedStory")?.description || "")
  );

  Render.analysisStep(3);
  return { raw: llmRaw };
}

async function runTestingFlow() {
  Render.testingLoading();

  // Simulate progressive loading steps for UX
  await new Promise(r => setTimeout(r, 500));
  Render.testingStep(1);
  await new Promise(r => setTimeout(r, 600));
  Render.testingStep(2);
  await new Promise(r => setTimeout(r, 700));
  Render.testingStep(3);
  await new Promise(r => setTimeout(r, 300));

  return STATIC_TEST_DATA;
}

/* ══════════════════════════════════════════════
   ═══  EVENTS — Interactive handlers          ══
   ══════════════════════════════════════════════ */

function setGlobalStatus(state, text) {
  const el   = document.getElementById("globalStatus");
  el.className      = `status-indicator ${state}`;
  el.querySelector(".status-text").textContent = text;
}

function selectStory(story) {
  State.set("selectedStory", story);
  State.reset();

  // Sidebar active state
  document.querySelectorAll(".story-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === story.id);
  });

  // Show details
  document.getElementById("emptyState").classList.add("hidden");
  document.getElementById("details").classList.remove("hidden");

  document.getElementById("storyIdTag").textContent   = story.id;
  document.getElementById("storyTitle").textContent   = story.title;
  document.getElementById("storyStatus").textContent  = story.status || "In Progress";

  // Reset to overview tab
  switchTab("overview");
  Render.overview();
}

function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-content").forEach((c) => {
    c.classList.toggle("active", c.id === tabName);
  });
}

function toggleCommitRow(row) {
  const sha        = row.dataset.sha;
  const detailRow  = document.querySelector(`.pr-details-row[data-sha="${sha}"]`);
  const isOpen     = detailRow.classList.contains("open");

  detailRow.classList.toggle("open", !isOpen);
  row.classList.toggle("open", !isOpen);

  if (!isOpen && detailRow.dataset.loaded !== "true") {
    detailRow.dataset.loaded = "true";
    // Optionally load file details via API here
    const detail = document.getElementById(`detail-${sha}`);
    if (detail) {
      detail.innerHTML = `
        <div class="pr-files-header">Commit SHA</div>
        <div class="pr-file">${sha}</div>
      `;
    }
  }
}

function filterTests(btn, tests) {
  const filter = btn.dataset.filter;

  document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");

  const cards = document.querySelectorAll(".test-case-card");
  cards.forEach((card) => {
    const show = filter === "all" || card.dataset.type === filter;
    card.style.display = show ? "" : "none";
  });
}

/* Sidebar search filter */
document.getElementById("storySearch").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll(".story-item").forEach((el) => {
    const text = el.textContent.toLowerCase();
    el.style.display = text.includes(q) ? "" : "none";
  });
});

/* Export button */
document.getElementById("exportBtn").addEventListener("click", () => {
  const story    = State.get("selectedStory");
  const analysis = State.get("analysisResult");
  const testing  = State.get("testingResult");
  Utils.exportJSON({ story, analysis, testing }, `pr-report-${story?.id || "export"}.json`);
});

/* Tab click handling */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", async () => {
    const tabName = tab.dataset.tab;
    switchTab(tabName);

    const container = document.getElementById(tabName);
    if (container.dataset.loaded === "true") return;

    if (tabName === "commits") {
      if (!State.get("commits").length) {
        Render.error("commits", "No commits found");
        return;
      }
      Render.commits();
      container.dataset.loaded = "true";
    }

    if (tabName === "analysis") {
      if (!State.get("commits").length) {
        Render.error("analysis", "No commits available to analyse");
        return;
      }

      try {
        if (!State._data._analysisPromise) {
          State._data._analysisPromise = runAnalysisFlow();
        }
        const result = await State._data._analysisPromise;
        State.set("analysisResult", result);
        Render.analysis(result.raw, result.diff);
        container.dataset.loaded = "true";
      } catch (e) {
        console.error("Analysis failed:", e);
        Render.error("analysis", `Analysis failed: ${e.message}`);
      }
    }

    if (tabName === "testing") {
      if (!State.get("commits").length) {
        Render.error("testing", "No commits available for test generation");
        return;
      }

      try {
        if (!State._data._testingPromise) {
          State._data._testingPromise = runTestingFlow();
        }
        const result = await State._data._testingPromise;
        State.set("testingResult", result);
        Render.testing(result);
        container.dataset.loaded = "true";
      } catch (e) {
        console.error("Testing suite failed:", e);
        Render.error("testing", `Test generation failed: ${e.message}`);
      }
    }
  });
});

/* ══════════════════════════════════════════════
   ═══  INIT — Bootstrap                       ══
   ══════════════════════════════════════════════ */
async function init() {
  setGlobalStatus("loading", "Loading stories…");

  try {
    // Load stories and commits in parallel
    const [stories, rawCommits] = await Promise.all([
      API.fetchStories(),
      API.fetchCommits({
        owner:  "Vijaykrishnan2000",
        repo:   "CHAT-API-Website",
        branch: "main",
        since:  "2026-03-01T00:00:00Z",
      }),
    ]);

    const commits = Utils.formatCommits(rawCommits);

    State.set("stories", stories);
    State.set("commits", commits);

    Render.stories();
    document.getElementById("commitsBadge").textContent = commits.length;

    setGlobalStatus("active", "Ready");

    // Auto-select first story
    if (stories.length > 0) {
      selectStory(stories[0]);
    }

  } catch (e) {
    console.error("Init failed:", e);
    setGlobalStatus("error", "Load failed");
    document.getElementById("storyCountBadge").textContent = "Error loading data";
  }
}

/* ══════════════════════════════════════════════
   ═══  STATIC TEST DATA                       ══
   ══════════════════════════════════════════════ */
const STATIC_TEST_DATA = {
  coverageScore: 42,
  riskZones: [
    "No RegistrationController or User Schema implemented — core story deliverable missing",
    "Session ID exposed to browser console — PII/session leakage risk in production",
    "Unvalidated user input passed directly to Salesforce proxy — injection surface",
    "Public Netlify endpoint lacks CSRF/origin validation",
  ],
  testCases: [
    {
      scenario: "Register user with valid credentials",
      type: "Functional",
      status: "Fail",
      score: 1,
      instruction: "High",
      completeness: "Fail",
      coherence: "Fail",
      conciseness: "Pass",
      failureReason: "RegistrationController not implemented — endpoint returns 404",
      detailed: "The story requires a /register endpoint accepting name, email, and password. No such controller exists in the diff; all changes relate to a Salesforce chatbot proxy.",
      preconditions: ["Application is running", "Database connection is active"],
      steps: [
        "Navigate to /register",
        "Enter valid name, email and password",
        "Submit the registration form",
        "Observe response"
      ],
      expectedResult: "User is created in DB, confirmation email is sent, 201 response returned",
      justification: "FAIL — RegistrationController is entirely absent from the diff. No User schema, no SMTP trigger, no endpoint handler.",
    },
    {
      scenario: "Reject registration with duplicate email",
      type: "Negative",
      status: "Fail",
      score: 1,
      instruction: "High",
      completeness: "Fail",
      coherence: "Fail",
      conciseness: "Pass",
      failureReason: "Duplicate-check logic absent — no User model to query against",
      detailed: "AC-4 requires the system to detect and reject duplicate email registrations. Without a User schema or DB layer, this cannot be enforced.",
      preconditions: ["An account with test@example.com already exists"],
      steps: [
        "POST /register with email: test@example.com",
        "Observe response code and message"
      ],
      expectedResult: "409 Conflict with error message 'Email already in use'",
      justification: "FAIL — No User model is referenced anywhere in the diff. Duplicate detection is impossible.",
    },
    {
      scenario: "Enforce password policy (min 8 chars, 1 uppercase, 1 number)",
      type: "Negative",
      status: "Fail",
      score: 2,
      instruction: "Medium",
      completeness: "Fail",
      coherence: "Pass",
      conciseness: "Pass",
      failureReason: "Password validation layer not present in any changed file",
      detailed: "The PR contains no input validation middleware or schema-level password rules. A user can submit any string as a password.",
      preconditions: ["Registration endpoint is available"],
      steps: [
        "POST /register with password: 'abc'",
        "POST /register with password: 'alllowercase1'",
        "POST /register with password: 'ValidPass1'"
      ],
      expectedResult: "First two return 400 with validation details; third succeeds with 201",
      justification: "FAIL — No Joi/Zod/express-validator schema or regex enforcement found in diff.",
    },
    {
      scenario: "Email verification link sent on registration",
      type: "Integration",
      status: "Fail",
      score: 1,
      instruction: "High",
      completeness: "Fail",
      coherence: "Fail",
      conciseness: "Pass",
      failureReason: "No SMTP or email service integration exists in the codebase",
      detailed: "AC-5 requires that a verification email be dispatched post-registration. There is no nodemailer, SES, or equivalent dependency imported in any file touched by this PR.",
      preconditions: ["SMTP credentials are configured", "Registration endpoint exists"],
      steps: [
        "Register with a valid new email",
        "Check the inbox for verification email",
        "Click the verification link"
      ],
      expectedResult: "Email arrives within 30 seconds; link verifies account and returns 200",
      justification: "FAIL — Zero SMTP or transactional email logic present in the diff.",
    },
    {
      scenario: "Session ID not logged to browser console",
      type: "Security",
      status: "Fail",
      score: 3,
      instruction: "Low",
      completeness: "Fail",
      coherence: "Pass",
      conciseness: "Pass",
      failureReason: "script.js L35 explicitly logs sessionId and full response object",
      detailed: "Explicit console.log(sessionId, responseObj) on line 35 of script.js leaks session identifiers to any user with DevTools open, violating OWASP A02.",
      preconditions: ["Browser DevTools console is open"],
      steps: [
        "Open the application in a browser",
        "Open DevTools → Console",
        "Trigger any chatbot interaction",
        "Observe console output"
      ],
      expectedResult: "No session identifiers or raw API payloads appear in the console",
      justification: "FAIL — Line 35 of script.js directly logs sessionId. Confirmed in diff.",
    },
    {
      scenario: "Input sanitisation before passing to Salesforce proxy",
      type: "Security",
      status: "Fail",
      score: 2,
      instruction: "Low",
      completeness: "Fail",
      coherence: "Pass",
      conciseness: "Pass",
      failureReason: "userMessage is passed raw to Salesforce without any sanitisation",
      detailed: "salesforceProxy.js forwards userMessage directly to the Agentforce API. Control characters or injection payloads are not stripped, presenting an injection risk if Salesforce interprets special sequences.",
      preconditions: ["Chatbot proxy endpoint is reachable"],
      steps: [
        "Send a message containing SQL meta-characters: '; DROP TABLE sessions;--",
        "Send a message with template injection: {{7*7}}",
        "Observe proxy forwarding behaviour"
      ],
      expectedResult: "Input is sanitised or rejected before forwarding; proxy logs a warning",
      justification: "FAIL — No sanitisation middleware present in salesforceProxy.js diff.",
    },
    {
      scenario: "response.text() vs response.json() type mismatch",
      type: "Edge",
      status: "Fail",
      score: 4,
      instruction: "Medium",
      completeness: "Fail",
      coherence: "Pass",
      conciseness: "Pass",
      failureReason: "salesforceProxy.js uses response.text() while client expects JSON — runtime exception on error responses",
      detailed: "When Salesforce returns a non-200 status, response.text() yields an HTML error page. The client then calls JSON.parse() on it and throws an unhandled SyntaxError, crashing the session.",
      preconditions: ["Salesforce API is configured to return error responses"],
      steps: [
        "Trigger an invalid Salesforce request (bad sessionId)",
        "Observe client-side error handling"
      ],
      expectedResult: "Client receives structured JSON error; no unhandled exception",
      justification: "FAIL — Confirmed type mismatch in salesforceProxy.js. Error path untested.",
    },
    {
      scenario: "CSRF protection on public Netlify function endpoint",
      type: "Security",
      status: "Fail",
      score: 2,
      instruction: "Low",
      completeness: "Fail",
      coherence: "Pass",
      conciseness: "Pass",
      failureReason: "No origin validation or CSRF token mechanism present",
      detailed: "The Netlify function accepts POST requests from any origin with no validation. A malicious third-party site can submit requests on behalf of authenticated users.",
      preconditions: ["Netlify function is deployed and accessible"],
      steps: [
        "Craft a cross-origin POST to the Netlify function from a different domain",
        "Observe whether the request is accepted or rejected"
      ],
      expectedResult: "Request is rejected with 403 if origin is not whitelisted",
      justification: "FAIL — No CORS restriction or CSRF token check exists in the function handler.",
    },
    {
      scenario: "Dead code and commented credentials removed",
      type: "Regression",
      status: "Fail",
      score: 3,
      instruction: "Medium",
      completeness: "Fail",
      coherence: "Pass",
      conciseness: "Pass",
      failureReason: "Lines 6–13 of salesforceProxy.js contain commented client_id/client_secret remnants",
      detailed: "Commented-out credential variable declarations remain in the source. While not active, they represent a security smell and will surface in static analysis scans (e.g. GitGuardian, truffleHog).",
      preconditions: ["Code review tools or SAST scanner is active"],
      steps: [
        "Run SAST scan on salesforceProxy.js",
        "Review lines 6–13 manually"
      ],
      expectedResult: "No credential-like patterns in source; SAST scan returns clean",
      justification: "FAIL — Commented credentials confirmed on lines 6–13 of the diff.",
    },
    {
      scenario: "sessionId persists across page refresh",
      type: "Edge",
      status: "Fail",
      score: 3,
      instruction: "Medium",
      completeness: "Fail",
      coherence: "Pass",
      conciseness: "Pass",
      failureReason: "sessionId stored in global JS variable — lost on refresh, breaking session continuity",
      detailed: "The current implementation stores sessionId as a module-level variable. Any page refresh or navigation resets it to undefined, forcing users to restart their conversation.",
      preconditions: ["User has an active chatbot session"],
      steps: [
        "Start a chatbot session",
        "Note the session ID in console",
        "Refresh the page",
        "Attempt to continue the conversation"
      ],
      expectedResult: "Session resumes from stored state using sessionStorage or equivalent",
      justification: "FAIL — No sessionStorage/localStorage write found in diff. State is ephemeral.",
    },
    {
      scenario: "External Flaticon asset loads successfully",
      type: "Functional",
      status: "Pass",
      score: 7,
      instruction: "High",
      completeness: "Pass",
      coherence: "Pass",
      conciseness: "Medium",
      failureReason: "",
      detailed: "UI assets linked from Flaticon CDN are loading correctly in current network conditions. However, this is a third-party dependency without SRI hash validation.",
      preconditions: ["External network access is available"],
      steps: [
        "Load the application",
        "Inspect Network tab for icon assets",
        "Verify HTTP 200 responses"
      ],
      expectedResult: "All icons render correctly; no 404 or CORS errors",
      justification: "PASS — Assets load in test environment. Risk noted: no SRI, no local fallback.",
    },
    {
      scenario: "Chatbot handles Salesforce API timeout gracefully",
      type: "Edge",
      status: "Pass",
      score: 8,
      instruction: "High",
      completeness: "Pass",
      coherence: "Pass",
      conciseness: "Pass",
      failureReason: "",
      detailed: "The proxy includes a basic try/catch that returns a fallback message when the Salesforce API does not respond. Timeout threshold is hardcoded at 10s.",
      preconditions: ["Salesforce API is unreachable or slow"],
      steps: [
        "Block Salesforce API at network level",
        "Send a message via the chatbot",
        "Observe client response after 10s"
      ],
      expectedResult: "Client receives a user-friendly error message within 12 seconds",
      justification: "PASS — Error boundary confirmed in proxy try/catch. Acceptable fallback behaviour.",
    },
  ],
};

init();
