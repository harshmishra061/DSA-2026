(async () => {
  /********************************************************************
   * Contest list page -> for each contest:
   * 1) Get contest slug from card href (/contest/<slug>/)
   * 2) Fetch https://leetcode.com/contest/api/info/<slug>/
   *    -> gives questions with title_slug (real problem slug)
   * 3) For each question, call GraphQL questionData -> status ("ac" = solved)
   * 4) Update the DOM badge: "X / Y" for each contest card
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

  /******************** 1) Scrape contests + keep DOM element ********************/
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
      const m = href.match(/^\/contest\/([^/]+)\/?$/);
      const slug = m ? m[1] : null;

      const name =
        a.querySelector(".text-base.font-medium")?.textContent?.trim() ||
        a.textContent.trim().slice(0, 80);

      // ✅ Find the badge span inside this card that looks like "0 / 4"
      // (we match by text pattern rather than exact class to be robust)
      const badgeSpan = Array.from(a.querySelectorAll("span")).find((s) =>
        /^\s*\d+\s*\/\s*\d+\s*$/.test((s.textContent || "").trim())
      );

      return slug
        ? {
            name,
            slug,
            href,
            url: abs(href),
            el: a,          // keep DOM element
            badgeEl: badgeSpan || null,
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
    const qs = Array.isArray(json?.questions) ? json.questions : [];
    return qs
      .map((q) => ({
        title: q?.title || q?.question__title || q?.translated_title || "(unknown)",
        titleSlug: q?.title_slug || q?.question__title_slug || q?.titleSlug || null,
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
            status
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

    const status = data?.data?.question?.status ?? null;
    return String(status || "").toLowerCase() === "ac";
  }

  /******************** 4) Run + update DOM ********************/
  const CONTEST_CONCURRENCY = 3;
  const PROBLEM_CONCURRENCY = 6;

  const contestReports = await mapLimit(contests, CONTEST_CONCURRENCY, async (contest) => {
    // show "..." while loading
    if (contest.badgeEl) contest.badgeEl.textContent = "... / ...";

    await sleep(120);

    const info = await fetchContestInfo(contest.slug);
    const questions = extractQuestionsFromContestApiJson(info);
    const total = questions.length;

    if (!total) {
      if (contest.badgeEl) contest.badgeEl.textContent = "0 / 0";
      return {
        contest: contest.name,
        contestSlug: contest.slug,
        contestUrl: contest.url,
        solvedCount: 0,
        totalCount: 0,
        note: "No questions found in contest API response",
      };
    }

    const solvedFlags = await mapLimit(questions, PROBLEM_CONCURRENCY, async (q) => {
      await sleep(80);
      return await getProblemStatus(q.titleSlug);
    });

    const solvedCount = solvedFlags.filter(Boolean).length;

    // ✅ Update the badge on the page
    if (contest.badgeEl) {
      contest.badgeEl.textContent = `${solvedCount} / ${total}`;
    } else {
      // If badge not found, try to create one (optional)
      // We'll just log in this version.
      console.warn(`Badge span not found for ${contest.name}.`);
    }

    return {
      contest: contest.name,
      contestSlug: contest.slug,
      contestUrl: contest.url,
      solvedCount,
      totalCount: total,
    };
  });

  /******************** 5) Print summary ********************/
  console.log("=== Solved count per contest ===");
  console.table(
    contestReports.map((r) => ({
      contest: r.contest,
      solved: `${r.solvedCount} / ${r.totalCount}`,
      slug: r.contestSlug,
    }))
  );

  window.__leetcodeContestSolvedCountReport = {
    at: new Date().toISOString(),
    contestReports,
  };

  console.log("Saved to window.__leetcodeContestSolvedCountReport");
})();
