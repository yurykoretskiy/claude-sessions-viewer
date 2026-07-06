# Root cwd grouping should not re-file sessions into mentioned subfolders

<!-- #codex -->

- Date: 06-07-2026
- Based on: INPUT-002

## Finding

The extension's previous default grouping could place a session started in the
current workspace root under a mentioned subfolder such as `assets`. That was
misleading because Claude transcript `cwd` is the ground truth for where a
session belongs. Content mentions are useful context, but they should not move
the session's tree location.

The corrected behavior is: if `cwd` equals the current workspace root, group the
session under the project name; if `cwd` is inside the workspace, group by the
first real child folder; otherwise group by the recorded `cwd`.
