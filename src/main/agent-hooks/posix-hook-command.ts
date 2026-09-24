import { POSIX_HOOK_STDIN_DRAIN_COMMAND } from './hook-stdin-contract'

function quotePosixShellString(value: string): string {
  // Why: the whole command is one single-quoted `sh -c` argument, so a value
  // quote must not itself be a single quote. `\`, `"`, `$`, and `` ` `` stay literal.
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`
}

function wrapForLoginShell(command: string): string {
  // Why: Cursor runs this string with the login shell. Nushell rejects `&&`
  // before `/bin/sh` starts. One single-quoted `sh -c` argument is valid there
  // and in sh, zsh, and bash. A `'` inside the argument is escaped for sh.
  return `/bin/sh -c '${command.replaceAll("'", "'\\''")}'`
}

// Why: guard for a readable executable so a stale entry at a missing script becomes a silent no-op, not an exit-127 failure on every tool call.
export function wrapPosixHookCommand(
  scriptPath: string,
  env: Record<string, string> = {},
  // Why: silence is a hard deny on gate events (Antigravity PreToolUse, #2426); those callers need the guard to still answer.
  options: { fallbackStdout?: string; requiredEnvVar?: string } = {}
): string {
  // Why: double quotes so $, `, ", \ in scriptPath stay literal inside the sh -c argument.
  const quoted = quotePosixShellString(scriptPath)
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${quotePosixShellString(value)}`)
    .join(' ')
  const invocation = envPrefix ? `${envPrefix} /bin/sh ${quoted}` : `/bin/sh ${quoted}`
  const fallback =
    options.fallbackStdout === undefined
      ? POSIX_HOOK_STDIN_DRAIN_COMMAND
      : `printf "%s\\n" ${quotePosixShellString(options.fallbackStdout)}; ${POSIX_HOOK_STDIN_DRAIN_COMMAND}`
  // Why: default form avoids Grok rejecting unset vars or splicing values into shell quotes at load
  // time; the child shell checks the current pane env before spawning the managed script.
  const guards = [
    ...(options.requiredEnvVar ? [`[ -n "\${${options.requiredEnvVar}-}" ]`] : []),
    `[ -f ${quoted} ]`,
    `[ -r ${quoted} ]`,
    `[ -x ${quoted} ]`
  ].join(' && ')
  return wrapForLoginShell(`if ${guards}; then ${invocation}; else ${fallback}; fi`)
}
