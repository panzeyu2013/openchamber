export const ALLOWED_COMMANDS = new Set(['git'])

export const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'rev-parse', 'status', 'log', 'diff', 'show', 'ls-files', 'ls-tree',
  'for-each-ref', 'name-rev', 'describe', 'shortlog', 'blame', 'grep',
  'cat-file', 'diff-tree', 'diff-index', 'diff-files', 'rev-list',
])

export const GATED_GIT_SUBCOMMANDS = new Map([
  ['branch', (rest) => rest.length === 0 || rest.every(a => a === '-r' || a === '-a' || a === '--remote' || a === '--list' || a === '--all')],
  ['tag', (rest) => rest.length === 0 || rest.every(a => a === '-l' || a === '--list' || a.startsWith('--points-at=') || a.startsWith('--contains='))],
  ['stash', (rest) => rest[0] === 'list' || rest[0] === 'show'],
  ['config', (rest) => {
    // Reject any argument containing '=' (writes to config)
    if (rest.some(r => typeof r === 'string' && r.includes('='))) return false
    // --list: no additional args
    if (rest.length === 1 && rest[0] === '--list') return true
    // --get / --get-regexp / --get-all: exactly one key argument
    if (rest.length === 2 && ['--get', '--get-regexp', '--get-all'].includes(rest[0])) return true
    // --get-urlmatch: section, variable, url (3 position args)
    if (rest.length === 4 && rest[0] === '--get-urlmatch') return true
    // --null (used with --get): allow up to 2 args (--null + --get + key)
    if (rest.length === 3 && rest[0] === '--null' && rest[1] === '--get') return true
    // --global / --local / --system: ignore scope flag, re-check with rest[1:]
    if (['--global', '--local', '--system', '--file'].includes(rest[0])) {
      const restWithoutScope = rest.slice(1)
      if (restWithoutScope.length === 0) return false
      if (restWithoutScope.length === 1 && restWithoutScope[0] === '--list') return true
      if (restWithoutScope.length === 2 && ['--get', '--get-regexp', '--get-all'].includes(restWithoutScope[0])) return true
      if (restWithoutScope.length === 3 && restWithoutScope[0] === '--null' && restWithoutScope[1] === '--get') return true
      if (restWithoutScope.length === 4 && restWithoutScope[0] === '--get-urlmatch') return true
    }
    return false
  }],
  ['remote', (rest) => rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url'],
  ['worktree', (rest) => rest.length === 0 || rest[0] === 'list'],
])

export const validateGatedSubcommand = (subcommand, rest) => {
  const validator = GATED_GIT_SUBCOMMANDS.get(subcommand)
  if (!validator) return null
  return validator(rest) ? null : `Git subcommand '${subcommand}' is restricted to read-only operations`
}

export const assertAllowedCommand = (command, args = [], cwd = '') => {
  if (!ALLOWED_COMMANDS.has(command)) return `Command '${command}' not allowed`
  if (command === 'git') {
    if (args.length === 0) return null
    if (/[;&|`$()\n'"]/.test(cwd || '')) return 'Invalid cwd'
    const sub = args[0]
    if (READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return null
    if (GATED_GIT_SUBCOMMANDS.has(sub)) return validateGatedSubcommand(sub, args.slice(1))
    return `Git subcommand '${sub}' not allowed`
  }
  return null
}
