// ✅ Simple usage:
// await checkContestSolved("weekly-contest-489");
// await checkContestSolved("https://leetcode.com/contest/weekly-contest-489/");

async function checkContestSolved(contestInput) {
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

  // Accepts "weekly-contest-489" OR full URL
  const contestSlug = (() => {
    if (!contestInput) return "";
    if (contestInput.includes("leetcode.com/contest/")) {
      const u = new URL(contestInput);
      const m = u.pathname.match(/\/contest\/([^/]+)\/?/);
      return m ? m[1] : "";
    }
    return String(contestInput).trim().replace(/^\/contest\//, "").replace(/\/$/, "");
  })();

  if (!contestSlug) {
    throw new Error("Invalid contest input. Pass a slug like 'weekly-contest-489' or a full contest URL.");
  }

  async function fetchContestInfo(slug) {
    const url = `https://leetcode.com/contest/api/info/${slug}/`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`Contest API HTTP ${res.status} for ${slug}`);
    return await res.json();
  }

  function extractQuestions(json) {
    const qs = Array.isArray(json?.questions) ? json.questions : [];
    return qs
      .map((q) => ({
        title: q?.title || "(unknown)",
        titleSlug: q?.title_slug || null,
      }))
      .filter((x) => !!x.titleSlug);
  }

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

    const status = q?.status ?? null; // usually "ac" if solved, else null
    return {
      id: q?.questionFrontendId ?? "",
      title: q?.title ?? "(unknown)",
      slug: q?.titleSlug ?? titleSlug,
      difficulty: q?.difficulty ?? "",
      solved: String(status || "").toLowerCase() === "ac",
      status,
      url: `https://leetcode.com/problems/${titleSlug}/`,
    };
  }

  // --- run ---
  const info = await fetchContestInfo(contestSlug);
  const questions = extractQuestions(info);

  if (!questions.length) {
    console.log(`No questions found for contest: ${contestSlug}`);
    console.log("API response:", info);
    return [];
  }

  const results = [];
  for (const q of questions) {
    await sleep(150); // gentle rate limiting
    results.push(await getProblemStatus(q.titleSlug));
  }

  console.log(`=== ${contestSlug}: solved status ===`);
  console.table(
    results.map((r) => ({
      id: r.id,
      difficulty: r.difficulty,
      solved: r.solved ? "✅" : "❌",
      title: r.title,
      slug: r.slug,
      url: r.url,
    }))
  );

  return results;
}
