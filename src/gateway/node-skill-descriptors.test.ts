import { describe, expect, it } from "vitest";
import { normalizeNodeSkillDescriptors } from "./node-skill-descriptors.js";

const descriptor = {
  name: "release-helper",
  description: "Prepare a release",
  content: "---\nname: release-helper\ndescription: Prepare a release\n---\n",
};

describe("normalizeNodeSkillDescriptors", () => {
  it("preserves valid revisions and treats malformed revisions as absent", () => {
    const revision = "a".repeat(64);

    expect(
      normalizeNodeSkillDescriptors({
        nodeId: "node-1",
        skills: [
          { ...descriptor, revision },
          { ...descriptor, name: "legacy-helper", revision: "malformed" },
        ],
      }),
    ).toEqual([
      { ...descriptor, name: "legacy-helper" },
      { ...descriptor, revision },
    ]);
  });
});
