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
  ['config', (rest) => rest.every(a => a === '--list' || a === '--get' || a === '--get-regexp' || a === '--get-all' || (a.startsWith('--get') && !a.includes('=')) && !rest.some(r => r.includes('=')))],
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
