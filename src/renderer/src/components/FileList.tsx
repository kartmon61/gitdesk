// File list shared by the commit panel, commit details and comparisons: path/tree view,
// Ctrl/Shift multi-select, drag between lists and folder rows like GitKraken.
import { useMemo, useState, type ReactNode } from 'react'
import { contextMenu, type MenuItem } from '../dialogs'
import { setUi, toggleCollapsed, useUi } from '../ui'

export interface FileItem {
  path: string
  oldPath?: string
  /** Status letter: A M D R C T U ? */
  letter: string
  extra?: ReactNode
}

const FILE_DRAG = 'application/x-gitdesk-files'

interface Props {
  /** Unique id; also the key for collapsed tree folders */
  id: string
  items: FileItem[]
  selected: Set<string>
  onSelect: (paths: Set<string>) => void
  /** Path whose diff is open */
  activePath?: string
  onOpen: (item: FileItem) => void
  /** Context menu for the given (selected) paths */
  menu: (paths: string[]) => MenuItem[]
  /** Hover buttons for one file */
  actions?: (item: FileItem) => ReactNode
  /** Hover buttons for a folder in tree view */
  folderActions?: (paths: string[]) => ReactNode
  /** Accepts files dragged from another list */
  onDropFiles?: (paths: string[], fromId: string) => void
  onFocusList?: () => void
}

interface Folder {
  name: string
  path: string
  folders: Map<string, Folder>
  files: FileItem[]
}

function buildTree(items: FileItem[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [] }
  for (const it of items) {
    const parts = it.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      const p = node.path ? `${node.path}/${part}` : part
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path: p, folders: new Map(), files: [] })
      node = node.folders.get(part)!
    }
    node.files.push(it)
  }
  // Collapse single-child folder chains ("src/main/git") like GitKraken's compact tree.
  const compact = (f: Folder): Folder => {
    for (const [k, child] of f.folders) f.folders.set(k, compact(child))
    if (f.path && f.files.length === 0 && f.folders.size === 1) {
      const only = [...f.folders.values()][0]
      return { ...only, name: `${f.name}/${only.name}` }
    }
    return f
  }
  return compact(root)
}

function allPaths(f: Folder): string[] {
  return [...f.files.map((x) => x.path), ...[...f.folders.values()].flatMap(allPaths)]
}

export function FileList(p: Props): ReactNode {
  const fileView = useUi((s) => s.fileView)
  const collapsed = useUi((s) => s.collapsed)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  // Natural order, so file_2 comes before file_10.
  const items = useMemo(() => [...p.items].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })), [p.items])
  const tree = useMemo(() => (fileView === 'tree' ? buildTree(items) : null), [fileView, items])

  // Visible order, used for Shift range selection.
  const order = useMemo(() => {
    if (!tree) return items.map((x) => x.path)
    const out: string[] = []
    const walk = (f: Folder): void => {
      for (const sub of [...f.folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
        if (!collapsed[`tree:${p.id}:${sub.path}`]) walk(sub)
      }
      for (const file of f.files) out.push(file.path)
    }
    walk(tree)
    return out
  }, [tree, items, p.id, collapsed])

  const click = (it: FileItem, e: React.MouseEvent): void => {
    p.onFocusList?.()
    if (e.shiftKey && anchor) {
      const [a, b] = [order.indexOf(anchor), order.indexOf(it.path)].sort((x, y) => x - y)
      if (a >= 0 && b >= 0) p.onSelect(new Set(order.slice(a, b + 1)))
      return
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(p.selected)
      if (next.has(it.path)) next.delete(it.path)
      else next.add(it.path)
      setAnchor(it.path)
      return p.onSelect(next)
    }
    setAnchor(it.path)
    p.onSelect(new Set([it.path]))
    p.onOpen(it)
  }

  const onMenu = (it: FileItem, e: React.MouseEvent): void => {
    p.onFocusList?.()
    const paths = p.selected.has(it.path) ? [...p.selected] : [it.path]
    if (!p.selected.has(it.path)) p.onSelect(new Set([it.path]))
    contextMenu(e, p.menu(paths))
  }

  const dragStart = (it: FileItem, e: React.DragEvent): void => {
    const paths = p.selected.has(it.path) ? [...p.selected] : [it.path]
    e.dataTransfer.setData(FILE_DRAG, JSON.stringify({ from: p.id, paths }))
    e.dataTransfer.effectAllowed = 'move'
  }

  const fileRow = (it: FileItem, depth: number): ReactNode => {
    const slash = it.path.lastIndexOf('/')
    const cls = ['file']
    if (p.selected.has(it.path)) cls.push('selected')
    if (p.activePath === it.path) cls.push('active')
    return (
      <div
        key={it.path}
        className={cls.join(' ')}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={(e) => click(it, e)}
        onContextMenu={(e) => onMenu(it, e)}
        draggable={!!p.onDropFiles || undefined}
        onDragStart={(e) => dragStart(it, e)}
        title={it.oldPath ? `${it.oldPath} → ${it.path}` : it.path}
      >
        <span className={`kind ${it.letter}`}>{it.letter}</span>
        <span className="ellipsis grow">
          {it.path.slice(slash + 1)}
          {!tree && slash > 0 && <span className="dim"> {it.path.slice(0, slash)}</span>}
        </span>
        {it.extra}
        {p.actions && (
          <span className="actions" onClick={(e) => e.stopPropagation()}>
            {p.actions(it)}
          </span>
        )}
      </div>
    )
  }

  const folderRows = (f: Folder, depth: number): ReactNode[] => {
    const out: ReactNode[] = []
    for (const sub of [...f.folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      const key = `tree:${p.id}:${sub.path}`
      const isClosed = !!collapsed[key]
      const paths = allPaths(sub)
      out.push(
        <div
          key={`d:${sub.path}`}
          className="file folder-row"
          style={{ paddingLeft: 12 + depth * 14 }}
          onClick={() => toggleCollapsed(key)}
          onContextMenu={(e) => {
            p.onSelect(new Set(paths))
            contextMenu(e, p.menu(paths))
          }}
          draggable={!!p.onDropFiles || undefined}
          onDragStart={(e) => {
            e.dataTransfer.setData(FILE_DRAG, JSON.stringify({ from: p.id, paths }))
          }}
        >
          <span className="dim">{isClosed ? '▸' : '▾'}</span>
          <span className="ellipsis grow">📁 {sub.name}</span>
          <span className="dim" style={{ fontSize: 11 }}>
            {paths.length}
          </span>
          {p.folderActions && (
            <span className="actions" onClick={(e) => e.stopPropagation()}>
              {p.folderActions(paths)}
            </span>
          )}
        </div>
      )
      if (!isClosed) out.push(...folderRows(sub, depth + 1))
    }
    out.push(...f.files.map((x) => fileRow(x, depth)))
    return out
  }

  return (
    <div
      className={`file-list${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        if (!p.onDropFiles || !e.dataTransfer.types.includes(FILE_DRAG)) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false)
        if (!p.onDropFiles) return
        try {
          const { from, paths } = JSON.parse(e.dataTransfer.getData(FILE_DRAG)) as { from: string; paths: string[] }
          if (from !== p.id) p.onDropFiles(paths, from)
        } catch {
          /* not a file drag */
        }
      }}
    >
      {tree ? folderRows(tree, 0) : items.map((x) => fileRow(x, 0))}
      {items.length === 0 && p.onDropFiles && <div className="dim drop-hint">여기로 파일을 끌어 놓을 수 있습니다</div>}
    </div>
  )
}

/** Toggle buttons for Path / Tree view, shown in panel headers. */
export function ViewToggle(): ReactNode {
  const fileView = useUi((s) => s.fileView)
  return (
    <span className="seg">
      <button className={fileView === 'path' ? 'on' : ''} title="경로 보기" onClick={() => setUi({ fileView: 'path' })}>
        ☰ 경로
      </button>
      <button className={fileView === 'tree' ? 'on' : ''} title="트리 보기" onClick={() => setUi({ fileView: 'tree' })}>
        🗀 트리
      </button>
    </span>
  )
}
