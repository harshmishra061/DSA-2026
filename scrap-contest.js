(async () => {
  /********************************************************************
   * Contest list page -> for each contest:
   * 1) Get contest slug from card href (/contest/<slug>/)
   * 2) Fetch https://leetcode.com/contest/api/info/<slug>/
   *    -> gives questions with title_slug (real problem slug)
   * 3) For each question, call GraphQL questionData -> status ("ac" = solved)
   ********************************************************************/

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const getCookie = (name) => {
    const m = document.cookie.match(new RegExp("(^|;\\s*)" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[2]) : "";
  };

  const csrfToken =
    document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ||
    getCookie("csrftoken");

  if (!csrfToken) {
    console.warn("CSRF token not found. Make sure you're logged in on leetcode.com.");
  }

  // Small concurrency limiter
  async function mapLimit(items, limit, worker) {
    const out = new Array(items.length);
    let i = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) break;
        try {
          out[idx] = await worker(items[idx], idx);
        } catch (e) {
          out[idx] = { __error: String(e) };
        }
      }
    });

    await Promise.all(runners);
    return out;
  }

  function abs(path) {
    return new URL(path, location.origin).toString();
  }

  /******************** 1) Scrape contests from the page ********************/
  // This matches the contest cards you showed initially.
  const contestAnchors = Array.from(
    document.querySelectorAll('a.flex.items-center.gap-4.px-4[href^="/contest/"]')
  );

  if (!contestAnchors.length) {
    console.error(
      "No contest cards found with selector: a.flex.items-center.gap-4.px-4[href^='/contest/']\n" +
        "Scroll a bit and try again, or LeetCode changed classes."
    );
    return;
  }

  const contests = contestAnchors
    .map((a) => {
      const href = a.getAttribute("href") || "";
      // href: /contest/weekly-contest-489/
      const m = href.match(/^\/contest\/([^/]+)\/?$/);
      const slug = m ? m[1] : null;

      const name =
        a.querySelector(".text-base.font-medium")?.textContent?.trim() ||
        a.textContent.trim().slice(0, 80);

      return slug
        ? {
            name,
            slug,
            href,
            url: abs(href),
          }
        : null;
    })
    .filter(Boolean);

  console.log(`Found ${contests.length} contest cards on this page.`);
  console.table(contests.map((c) => ({ name: c.name, slug: c.slug, href: c.href })));

  /******************** 2) Contest API: get problems (REAL slugs) ********************/
  async function fetchContestInfo(contestSlug) {
    const url = `https://leetcode.com/contest/api/info/${contestSlug}/`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`Contest API HTTP ${res.status} for ${contestSlug}`);
    return await res.json();
  }

  function extractQuestionsFromContestApiJson(json) {
    // Known keys typically:
    // json.contest (meta)
    // json.questions (array)
    const qs = Array.isArray(json?.questions) ? json.questions : [];
    return qs
      .map((q) => ({
        title: q?.title || q?.question__title || q?.translated_title || "(unknown)",
        titleSlug: q?.title_slug || q?.question__title_slug || q?.titleSlug || null,
        questionId: q?.question_id || q?.id || null,
        credit: q?.credit || null,
      }))
      .filter((x) => !!x.titleSlug);
  }

  /******************** 3) GraphQL: solved status per problem ********************/
  async function getProblemStatus(titleSlug) {
    const payload = {
      operationName: "questionData",
      variables: { titleSlug },
      query: `
        query questionData($titleSlug: String!) {
          question(titleSlug: $titleSlug) {
            title
            titleSlug
            status
            difficulty
            questionFrontendId
          }
        }
      `,
    };

    const res = await fetch("https://leetcode.com/graphql", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-csrftoken": csrfToken,
        "x-requested-with": "XMLHttpRequest",
        referer: "https://leetcode.com/",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status} for ${titleSlug}`);
    const data = await res.json();

    const q = data?.data?.question;
    const status = q?.status ?? null;

    return {
      titleSlug,
      title: q?.title ?? "(unknown)",
      frontendId: q?.questionFrontendId ?? "",
      difficulty: q?.difficulty ?? "",
      status,
      solved: String(status || "").toLowerCase() === "ac",
      url: `https://leetcode.com/problems/${titleSlug}/`,
    };
  }

  /******************** 4) Run end-to-end ********************/
  const CONTEST_CONCURRENCY = 3;   // tune if you want
  const PROBLEM_CONCURRENCY = 6;   // tune if you want

  const contestReports = await mapLimit(contests, CONTEST_CONCURRENCY, async (contest) => {
    // small delay between contest calls
    await sleep(150);

    const info = await fetchContestInfo(contest.slug);
    const questions = extractQuestionsFromContestApiJson(info);

    if (!questions.length) {
      return {
        contest: contest.name,
        contestSlug: contest.slug,
        contestUrl: contest.url,
        problems: [],
        note: "No questions found in contest API response",
      };
    }

    const checked = await mapLimit(questions, PROBLEM_CONCURRENCY, async (q) => {
      await sleep(120);
      const st = await getProblemStatus(q.titleSlug);
      return {
        contestProblemTitle: q.title,
        title: st.title,
        slug: st.titleSlug,
        id: st.frontendId,
        difficulty: st.difficulty,
        solved: st.solved ? "✅" : "❌",
        status: st.status,
        url: st.url,
      };
    });

    return {
      contest: contest.name,
      contestSlug: contest.slug,
      contestUrl: contest.url,
      problems: checked,
    };
  });

  /******************** 5) Print nicely ********************/
  console.log("=== Contest -> Problems (Solved?) ===");
  for (const rep of contestReports) {
    console.groupCollapsed(`${rep.contest} (${rep.problems.length} problems)`);
    if (rep.note) console.warn(rep.note);
    console.table(rep.problems);
    console.groupEnd();
  }

  // Flat table as well (easy to copy)
  const flat = contestReports.flatMap((rep) =>
    rep.problems.map((p) => ({
      contest: rep.contest,
      contestSlug: rep.contestSlug,
      problemId: p.id,
      difficulty: p.difficulty,
      solved: p.solved,
      title: p.title,
      slug: p.slug,
      url: p.url,
    }))
  );

  console.log("=== Flat table (all contests combined) ===");
  console.table(flat);

  window.__leetcodeContestSolvedReport = { contestReports, flat, at: new Date().toISOString() };
  console.log("Saved to window.__leetcodeContestSolvedReport");
})();
