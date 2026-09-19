export type SkillReferencePath = {
  /** Canonical source SKILL.md path recorded before runtime preparation. */
  skillFile: string;
  /** Exact SKILL.md locator readable by the selected runtime. */
  readPath: string;
};

type SkillReferenceSnapshot = {
  librarySelections?: readonly unknown[];
  nodeSkillReferencePaths?: readonly SkillReferencePath[];
};

export function hasSkillRefs(
  snapshot: SkillReferenceSnapshot | undefined,
  includeLibrarySelections: boolean,
): boolean {
  return Boolean(
    snapshot?.nodeSkillReferencePaths?.length ||
    (includeLibrarySelections && snapshot?.librarySelections?.length),
  );
}

/** Rewrites host-generated explicit skill references to the selected runtime's exact copies. */
export function remapSkillReferencePaths(
  text: string,
  paths?: readonly SkillReferencePath[],
): string {
  return (paths ?? []).reduce(
    (result, item) => result.replaceAll(item.skillFile, item.readPath),
    text,
  );
}

export function remapSkillRefs(
  text: string,
  paths: readonly SkillReferencePath[] | undefined,
  snapshot: SkillReferenceSnapshot | undefined,
): string {
  return remapSkillReferencePaths(text, [
    ...(paths ?? []),
    ...(snapshot?.nodeSkillReferencePaths ?? []),
  ]);
}

export function remapPreparedSkillRefs(
  text: string,
  prepared: { usagePaths?: readonly SkillReferencePath[] },
  input: { skillsSnapshot?: SkillReferenceSnapshot },
): string {
  return remapSkillRefs(text, prepared.usagePaths, input.skillsSnapshot);
}
