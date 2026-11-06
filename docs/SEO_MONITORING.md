# SEO, Traffic & Analytics Monitoring Guide: OpenCode Router

**Project**: OpenCode Router  
**Repository**: [https://github.com/EhsanCreator/OpenCode-Router](https://github.com/EhsanCreator/OpenCode-Router)  
**Author**: Ehsan Shahriyari ([@EhsanCreator](https://github.com/EhsanCreator))  
**Target Release**: v1.0.0  
**Verified Platform**: Ubuntu 24.04 LTS (64-bit x86_64)  

---

## 1. Overview & Data Integrity Principles

Tracking organic search performance, GitHub discovery, and developer adoption requires continuous observation of real telemetry.

> [!NOTE]
> **Measurement Principle**: In accordance with project directives, this guide establishes a measurement framework. It contains **no fabricated metrics, hypothetical conversion rates, or synthetic visitor counts**. Metrics are to be logged strictly from official analytics interfaces (GitHub Insights and Google Search Console).

---

## 2. GitHub Traffic Analytics

GitHub provides built-in, privacy-preserving repository metrics under the **Insights > Traffic** tab of the repository.

### Key Metrics Defined:
- **Unique Visitors**: Distinct GitHub users who viewed any repository page during the past 14 days. Indicates audience reach.
- **Total Views**: Raw page impressions across `README.md`, issues, releases, and files. Indicates content engagement.
- **Git Clones**: Total `git clone` operations over HTTPS/SSH. Measures active developer adoption.
- **Unique Cloners**: Number of distinct developers/IPs who cloned the repository.
- **Referring Sites**: External domains driving inbound traffic (e.g., Google, Reddit, Hacker News, Twitter, StackOverflow).
- **Popular Content**: Specific paths viewed most frequently (e.g., `/README.md`, `/docs/articles/...`).

### Review Cadence:
- **Frequency**: Weekly.
- *Retention Notice*: GitHub retains 14 days of detailed traffic history. Logging data weekly into the tracking template below ensures historical continuity.

---

## 3. Google Search Console (For Documentation & Website)

When a documentation website (such as GitHub Pages or a custom domain) is deployed, Google Search Console (GSC) is the primary tool for monitoring organic search performance.

### Configuration Steps:
1. **Property Setup**:
   - For GitHub Pages (`https://ehsancreator.github.io/OpenCode-Router/`): Add as a **URL-prefix property**.
   - For a custom domain (`https://opencode-router.dev`): Add as a **Domain property** via DNS TXT verification.
2. **Sitemap Submission**:
   - Provide the clean XML sitemap URL (e.g., `https://ehsancreator.github.io/OpenCode-Router/sitemap.xml`).
3. **Core Metrics to Monitor**:
   - **Total Clicks**: Number of times users clicked from a Google search result to your documentation.
   - **Total Impressions**: Number of times any page appeared in Google search results for a user's query.
   - **Average CTR (Click-Through Rate)**: Clicks divided by Impressions (`Clicks / Impressions * 100`). Measures headline and snippet relevance.
   - **Average Position**: Average ranking of your URLs across all tracked queries.
4. **Index Coverage Monitoring**:
   - Regularly check **Pages > Indexing** to confirm that articles are indexed without `Crawl anomaly`, `404 Not Found`, or `Redirect error`.

---

## 4. Weekly SEO & Discovery Tracking Template

Copy this template into a local tracking log (e.g., `docs/logs/weekly-seo-log.md` or a personal spreadsheet) at the end of each calendar week:

```markdown
### Week Ending: [YYYY-MM-DD]

#### 1. GitHub Insights (14-Day Trailing Window)
- **Unique Visitors**: [Count]
- **Total Views**: [Count]
- **Unique Cloners**: [Count]
- **Total Clones**: [Count]
- **Repository Stars (Total)**: [Count]
- **Forks (Total)**: [Count]
- **Top 3 Referrers**:
  1. [e.g., google.com / reddit.com / github.com]
  2. [Referrer 2]
  3. [Referrer 3]

#### 2. Google Search Console (If Docs Site Active)
- **Total Clicks**: [Count]
- **Total Impressions**: [Count]
- **Average CTR**: [%]
- **Average Position**: [Rank]
- **Top 5 Search Queries**:
  1. [Query 1] — [Impressions / Clicks / Position]
  2. [Query 2]
  3. [Query 3]
  4. [Query 4]
  5. [Query 5]
- **Top 3 Landing Pages**:
  1. [URL 1]
  2. [URL 2]
  3. [URL 3]

#### 3. Qualitative Notes & Actions
- **Community Issues / Discussions Opened**: [Notes on real user feedback]
- **Content Gaps Identified**: [New error messages or queries observed]
- **Action Items for Upcoming Week**: [Updates to articles, new FAQs, keyword tuning]
```

---

## 5. Continuous Improvement Cycle

```
[Inspect Real Inquiries / Issues]
                │
                ▼
[Identify Exact Error Message (e.g., "ETIMEDOUT 198.51.100.45")]
                │
                ▼
[Add Practical Troubleshooting Entry to Target Article]
                │
                ▼
[Observe Google Search Console / GitHub Traffic Logs]
                │
                ▼
[Refine Snippets & Headings for Search Relevance]
```

By maintaining this structured feedback loop, the OpenCode Router project maintains high technical relevance, accurate search intent alignment, and consistent developer trust over time.
