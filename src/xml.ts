// A small subset of Python's xml.etree.ElementTree, with the same serialization, for the
// port of homr's MusicXML generator.

export class XmlElement {
  text: string | undefined
  readonly attrib: Map<string, string>
  readonly children: XmlElement[] = []

  constructor(
    /** The tag, or undefined for a comment. */
    readonly tag: string | undefined,
    attrib: Record<string, string> = {},
  ) {
    this.attrib = new Map(Object.entries(attrib))
  }

  static comment(text: string): XmlElement {
    const c = new XmlElement(undefined)
    c.text = text
    return c
  }

  get length(): number {
    return this.children.length
  }

  get(name: string, fallback?: string): string | undefined {
    return this.attrib.get(name) ?? fallback
  }

  set(name: string, value: string): void {
    this.attrib.set(name, value)
  }

  append(child: XmlElement): void {
    this.children.push(child)
  }

  extend(children: Iterable<XmlElement>): void {
    for (const c of children) this.children.push(c)
  }

  insert(index: number, child: XmlElement): void {
    // list.insert clamps the index like Python
    const n = this.children.length
    const i = index < 0 ? Math.max(0, n + index) : Math.min(index, n)
    this.children.splice(i, 0, child)
  }

  /** Removes the child itself (Python's remove compares elements by identity). */
  remove(child: XmlElement): void {
    const i = this.children.indexOf(child)
    if (i < 0) throw new Error('list.remove(x): x not in list')
    this.children.splice(i, 1)
  }

  indexOf(child: XmlElement): number {
    const i = this.children.indexOf(child)
    if (i < 0) throw new Error('x not in list')
    return i
  }

  /** The children matching a path of tags like "measure/attributes/divisions". */
  findall(path: string): XmlElement[] {
    let current: XmlElement[] = [this]
    for (const tag of path.split('/')) current = current.flatMap((e) => e.children.filter((c) => c.tag === tag))
    return current
  }

  find(path: string): XmlElement | undefined {
    return this.findall(path)[0]
  }

  /** The text of the first match ("" if it has none), or the fallback if nothing matches. */
  findtext(path: string, fallback?: string): string | undefined {
    const e = this.find(path)
    return e ? (e.text ?? '') : fallback
  }

  /** The element and its descendants with the tag, depth first. */
  *iter(tag?: string): Generator<XmlElement> {
    if (tag === undefined || this.tag === tag) yield this
    for (const c of this.children) yield* c.iter(tag)
  }
}

export function subElement(parent: XmlElement, tag: string, attrib: Record<string, string> = {}, text?: string): XmlElement {
  const e = new XmlElement(tag, attrib)
  if (text !== undefined) e.text = text
  parent.append(e)
  return e
}

const escapeCdata = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttrib = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#09;')

function serialize(e: XmlElement, out: string[]): void {
  if (e.tag === undefined) {
    out.push(`<!--${e.text ?? ''}-->`)
    return
  }
  out.push(`<${e.tag}`)
  for (const [k, v] of e.attrib) out.push(` ${k}="${escapeAttrib(v)}"`)
  if (e.text || e.children.length > 0) {
    out.push('>')
    if (e.text) out.push(escapeCdata(e.text))
    for (const c of e.children) serialize(c, out)
    out.push(`</${e.tag}>`)
  } else {
    out.push(' />')
  }
}

/**
 * ElementTree(root).write(..., encoding="unicode", xml_declaration=True) as homr writes it,
 * or ET.tostring(root, encoding="unicode") without the declaration.
 */
export function toXmlString(root: XmlElement, declaration = true): string {
  const out = declaration ? ["<?xml version='1.0' encoding='utf-8'?>\n"] : []
  serialize(root, out)
  return out.join('')
}
