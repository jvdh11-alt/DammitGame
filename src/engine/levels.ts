export type Requirement = { type: 'set' | 'run'; size: number };
export type Level = { id: number; requirements: Requirement[] };

const set = (size: number): Requirement => ({ type: 'set', size });
const run = (size: number): Requirement => ({ type: 'run', size });

/** PLACEHOLDER ladder: replace with the real Dammit levels. Edit freely, nothing else depends on the values. */
export const DEFAULT_LEVELS: Level[] = [
  [set(3)],
  [run(4)],
  [set(3), set(3)],
  [set(3), run(4)],
  [run(7)],
  [set(4), run(4)],
  [run(8)],
  [set(4), set(4)],
  [run(9)],
  [set(5), set(3)],
].map((requirements, i) => ({ id: i + 1, requirements }));
