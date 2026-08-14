import { useState } from 'react'
import { CheckCircle2, MessageCircle, Plus, RotateCcw, Send, X } from 'lucide-react'
import type { CanvasComment, Point } from '../../model/project'

export interface CommentsPanelProps {
  comments: CanvasComment[]; selectedNodeId?: string; viewportCenter: Point
  author: { id: string; name: string }
  onAdd(comment: CanvasComment): void
  onUpdate(id: string, updater: (comment: CanvasComment) => CanvasComment): void
}

export function CommentsPanel({ comments, selectedNodeId, viewportCenter, author, onAdd, onUpdate }: CommentsPanelProps) {
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
  const [reply, setReply] = useState<Record<string, string>>({})
  if (!open) return <button aria-label="打开评论" className="comments-trigger" onClick={() => setOpen(true)} type="button"><MessageCircle /><span>{comments.filter((item) => !item.resolvedAt).length}</span></button>
  return <aside aria-label="评论" className="comments-panel">
    <header><strong><MessageCircle />评论</strong><button aria-label="关闭评论" onClick={() => setOpen(false)} type="button"><X /></button></header>
    <form onSubmit={(event) => { event.preventDefault(); const text = body.trim(); if (!text) return; onAdd({ id: crypto.randomUUID(), authorId: author.id, authorName: author.name, body: text, position: viewportCenter, ...(selectedNodeId ? { nodeId: selectedNodeId } : {}), createdAt: new Date().toISOString(), replies: [] }); setBody('') }}><textarea aria-label="新评论" onChange={(event) => setBody(event.target.value)} placeholder={selectedNodeId ? '评论当前节点' : '评论当前画布位置'} value={body} /><button aria-label="发布评论" type="submit"><Plus /></button></form>
    <div>{comments.map((comment) => <article data-resolved={Boolean(comment.resolvedAt) || undefined} key={comment.id}>
      <div><strong>{comment.authorName}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></div>
      <p>{comment.body}</p>{comment.nodeDeleted ? <small>关联对象已删除，评论保留在最后位置</small> : null}
      {comment.replies.map((item) => <blockquote key={item.id}><strong>{item.authorName}</strong> {item.body}</blockquote>)}
      <form onSubmit={(event) => { event.preventDefault(); const text = reply[comment.id]?.trim(); if (!text) return; onUpdate(comment.id, (current) => ({ ...current, replies: [...current.replies, { id: crypto.randomUUID(), authorId: author.id, authorName: author.name, body: text, createdAt: new Date().toISOString() }] })); setReply((current) => ({ ...current, [comment.id]: '' })) }}><input aria-label={`回复 ${comment.authorName}`} value={reply[comment.id] ?? ''} onChange={(event) => setReply((current) => ({ ...current, [comment.id]: event.target.value }))} /><button aria-label="发送回复" type="submit"><Send /></button></form>
      <button onClick={() => onUpdate(comment.id, (current) => current.resolvedAt ? ({ ...current, resolvedAt: undefined, resolvedBy: undefined }) : ({ ...current, resolvedAt: new Date().toISOString(), resolvedBy: author.id }))} type="button">{comment.resolvedAt ? <><RotateCcw />重新打开</> : <><CheckCircle2 />解决</>}</button>
    </article>)}</div>
  </aside>
}
