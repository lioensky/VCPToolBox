// No external dependencies needed for this VCP plugin

// Helper to read from stdin
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

// Helper to write to stdout
function writeStdout(data) {
  // VCP expects a single line of JSON
  process.stdout.write(JSON.stringify(data) + '\n');
}

// Function to format bookmark data (copied from original project's src/utils.ts)
function compactBookmark(bookmark) {
  let content;
  if (bookmark.content.type === "link") {
    content = `Bookmark type: link
Bookmarked URL: ${bookmark.content.url}
description: ${bookmark.content.description ?? ""}
author: ${bookmark.content.author ?? ""}
publisher: ${bookmark.content.publisher ?? ""}`;
  } else if (bookmark.content.type === "text") {
    content = `Bookmark type: text
  Source URL: ${bookmark.content.sourceUrl ?? ""}`;
  } else if (bookmark.content.type === "asset") {
    content = `Bookmark type: media
Asset ID: ${bookmark.content.assetId}
Asset type: ${bookmark.content.assetType}
Source URL: ${bookmark.content.sourceUrl ?? ""}`;
  } else {
    content = `Bookmark type: unknown`;
  }

  return `Bookmark ID: ${bookmark.id}
  Created at: ${bookmark.createdAt}
  Title: ${
    bookmark.title
      ? bookmark.title
      : ((bookmark.content.type === "link" ? bookmark.content.title : "") ?? "")
  }
  Summary: ${bookmark.summary ?? ""}
  Note: ${bookmark.note ?? ""}
  ${content}
  Tags: ${bookmark.tags.map((t) => t.name).join(", ")}`;
}

// Main execution function
async function main() {
  try {
    const input = await readStdin();
    if (!input) {
        throw new Error("No input received from stdin.");
    }
    const args = JSON.parse(input);

    // Parameter compatibility and validation
    const query = args.query || args.q || args.text;
    const limit = args.limit || args.size || 10;
    const nextCursor = args.nextCursor;

    if (!query) {
      throw { code: "INVALID_PARAMS", message: "Missing required parameter: query" };
    }

    const { KARAKEEP_API_ADDR, KARAKEEP_API_KEY } = process.env;
    if (!KARAKEEP_API_ADDR || !KARAKEEP_API_KEY) {
      throw { code: "CONFIG_ERROR", message: "Missing KARAKEEP_API_ADDR or KARAKEEP_API_KEY environment variables" };
    }

    // Construct the search URL
    const searchUrl = new URL(`${KARAKEEP_API_ADDR}/api/v1/bookmarks/search`);
    searchUrl.searchParams.append('q', query);
    searchUrl.searchParams.append('limit', limit);
    searchUrl.searchParams.append('includeContent', 'false');
    if (nextCursor) {
        searchUrl.searchParams.append('cursor', nextCursor);
    }

    const response = await fetch(searchUrl.toString(), {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${KARAKEEP_API_KEY}`,
        },
    });

    if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ message: 'Failed to parse error response' }));
        throw { code: "API_ERROR", message: `API request failed with status ${response.status}: ${errorBody.message || 'Unknown error'}` };
    }

    const data = await response.json();

    writeStdout({
      status: "success",
      result: {
        content: data.bookmarks.map((b) => ({
          type: "text",
          text: compactBookmark(b),
        })),
        nextCursor: data.nextCursor || null,
      },
    });
  } catch (e) {
    writeStdout({
      status: "error",
      code: e.code || "PLUGIN_ERROR",
      error: e.message || "An unexpected error occurred.",
    });
    process.exit(1);
  }
}

main();