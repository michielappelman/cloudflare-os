// The glyph shown for a workspace in lists: the emoji the quick model picked for it
// (WorkspaceMetadata.icon), or a neutral monogram of its title for workspaces that don't have one
// yet. Callers own the surrounding tile (size, background, radius).

export function workspaceInitials(title: string | undefined): string {
  const t = (title || 'Untitled').trim()
  if (!t) return 'UG'
  const parts = t.split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || t.slice(0, 2).toUpperCase()
}

export function WorkspaceIcon({
  icon,
  title,
  emojiClassName,
}: {
  icon: string | undefined
  title: string | undefined
  /** Font size etc. for the emoji, which reads smaller than letters at the same size. */
  emojiClassName: string
}) {
  if (icon) {
    return (
      <span aria-hidden="true" className={`leading-none ${emojiClassName}`}>
        {icon}
      </span>
    )
  }
  return <span aria-hidden="true">{workspaceInitials(title)}</span>
}
