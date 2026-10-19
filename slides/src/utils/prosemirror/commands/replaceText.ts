import { EditorView } from 'prosemirror-view'
import { Mark, NodeType, Node } from 'prosemirror-model'

export const replaceText = (view: EditorView, newText: string) => {
  const { state } = view
  const { schema, doc } = state

  let marks: Mark[] = []
  let nodeType: NodeType = schema.nodes.paragraph

  if (doc.content.size > 2) {
    const firstCharPos = doc.resolve(1)
    
    marks = [...firstCharPos.marks()]
    // In a list, position 1 is not inside text: take the marks of the first text instead.
    let firstText: Node | null = null
    doc.descendants(node => {
      if (!firstText && node.isText) firstText = node
      return !firstText
    })
    if (firstText) marks = [...(firstText as Node).marks]
    
    nodeType = firstCharPos.parent.type
  }

  const lines = newText.split('\n')
  
  let newNodes: Node[] = lines.map((line: string) => {
    if (line.trim() === '') return nodeType.create()
    
    const textNode = schema.text(line, marks)
    return nodeType.create(null, textNode)
  })

  // Text that was a list stays a list: "- " / "1. " lines become its items, in the original list's style.
  const list = doc.firstChild
  if (list && (list.type === schema.nodes.bullet_list || list.type === schema.nodes.ordered_list)) {
    const marker = /^\s*(?:[-*•]|\d+[.)])\s+/
    const itemParagraph = list.firstChild?.firstChild
    const items = lines.filter(line => line.trim()).map(line => {
      const text = line.replace(marker, '')
      const paragraph = schema.nodes.paragraph.create(itemParagraph?.attrs ?? null, text ? schema.text(text, marks) : null)
      return schema.nodes.list_item.create(list.firstChild?.attrs ?? null, paragraph)
    })
    if (items.length) newNodes = [list.type.create(list.attrs, items)]
  }

  const tr = state.tr
  
  tr.replaceWith(0, doc.content.size, newNodes)

  view.dispatch(tr)
}