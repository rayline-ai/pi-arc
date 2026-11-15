# Changelog

## [Unreleased]

- `"decisions": "local"` in `rayline.json`: ARC decides on this machine, in the Rayline CLI's local process (0.5.2 or later), found with `rayline local status --json`. No fallback to hosted ARC: a turn the local process cannot decide fails. The footer shows `route: local · <model> · <ms>`.
- `/rayline setup` chooses local or hosted decisions; for local it checks the Rayline CLI, signs in, starts the local process and saves `decisions`. `/rayline start` and `/rayline stop` start and stop the local process.
- `/rayline` shows the first decision's time apart from later ones, the models that took the turns, and, with local decisions, that no decision was hosted.
- `rayline.json` is optional. Without it, ARC routes between Opus 5.5, Haiku 5.5 and GPT-6 Luna through Rayline, so the Rayline key is the only setup. A file that sets only `local` keeps these cloud models.

## [0.1.0] - 2026-11-13

- First release: the `rayline/arc` virtual model, `rayline.json` configuration, and the `/rayline` command.
