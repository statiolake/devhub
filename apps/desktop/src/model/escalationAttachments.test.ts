import { describe, expect, it } from "vitest";
import { splitAttachments } from "./escalationAttachments.js";

const A = "/u/devhub/escalations/3/a1-shot.png";
const B = "/u/devhub/escalations/3/a2-flow.png";

describe("an escalation's attachments, read back", () => {
  it("takes main's 添付 section off the body, each picture with its caption or name", () => {
    expect(
      splitAttachments(
        `## 決めてほしいこと\n\nどちらか\n\n## 添付\n\n**staging** — *shot.png*\n\n![staging](<${A}>)\n\n*flow.png*\n\n![flow.png](<${B}>)\n`,
      ),
    ).toEqual({
      body: "## 決めてほしいこと\n\nどちらか",
      attachments: [
        { path: A, name: "shot.png", caption: "staging" },
        { path: B, name: "flow.png" },
      ],
    });
  });

  it("leaves a body with no section, or one in another shape, to the renderer", () => {
    const none = "## 決めてほしいこと\n\nどちらか";
    expect(splitAttachments(none)).toEqual({ body: none, attachments: [] });
    for (const markdown of [
      `## 添付\n\nスクショは後で送ります`,
      `## 添付\n\n*shot.png*\n\n![shot](<${A}>)\n\nほかにも`,
      `## 添付\n\n*shot.png*\n\n![shot](${A})`,
      `## 添付`,
    ]) {
      expect(splitAttachments(markdown)).toEqual({
        body: markdown,
        attachments: [],
      });
    }
  });

  it("reads the last section: one the author wrote earlier stays in the body", () => {
    const earlier = `## 添付\n\n下に貼りました\n\n## 理由\n\nx`;
    expect(
      splitAttachments(
        `${earlier}\n\n## 添付\n\n*shot.png*\n\n![shot](<${A}>)`,
      ),
    ).toEqual({ body: earlier, attachments: [{ path: A, name: "shot.png" }] });
  });
});
