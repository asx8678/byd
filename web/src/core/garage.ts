// The garage around bay 561. Its layout now lives in content/scenes/garage-561.json (a photo survey;
// the file's notes give the survey frame). This module keeps the old names for code that used them.
export type { Obstacle, ObstacleClass, Rect, Bay } from './scene';
export { GARAGE_561 } from './content';
/** The name of a start in a scene ('left', 'right' and 'across' in the garage). */
export type StartName = string;
