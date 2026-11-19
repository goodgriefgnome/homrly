// Port of OpenCV's Subdiv2D (modules/geometry/src/subdivision2d.cpp in OpenCV 5): the
// incremental Delaunay triangulation homr's staff dewarping uses. opencv.js does not
// include it. Only what homr needs is ported: initDelaunay, insert and getTriangleList,
// with the same float32 and double arithmetic, so the triangles and their order match.
//
// The original carries this license:
//
//                        Intel License Agreement
//                For Open Source Computer Vision Library
//
// Copyright (C) 2000, Intel Corporation, all rights reserved.
// Third party copyrights are property of their respective owners.
//
// Redistribution and use in source and binary forms, with or without modification,
// are permitted provided that the following conditions are met:
//
//   * Redistribution's of source code must retain the above copyright notice,
//     this list of conditions and the following disclaimer.
//
//   * Redistribution's in binary form must reproduce the above copyright notice,
//     this list of conditions and the following disclaimer in the documentation
//     and/or other materials provided with the distribution.
//
//   * The name of Intel Corporation may not be used to endorse or promote products
//     derived from this software without specific prior written permission.
//
// This software is provided by the copyright holders and contributors "as is" and
// any express or implied warranties, including, but not limited to, the implied
// warranties of merchantability and fitness for a particular purpose are disclaimed.
// In no event shall the Intel Corporation or contributors be liable for any direct,
// indirect, incidental, special, exemplary, or consequential damages
// (including, but not limited to, procurement of substitute goods or services;
// loss of use, data, or profits; or business interruption) however caused
// and on any theory of liability, whether in contract, strict liability,
// or tort (including negligence or otherwise) arising in any way out of
// the use of this software, even if advised of the possibility of such damage.

const f = Math.fround
const FLT_EPSILON = 1.1920928955078125e-7

const PTLOC_ERROR = -2
const PTLOC_INSIDE = 0
const PTLOC_VERTEX = 1
const PTLOC_ON_EDGE = 2

const PREV_AROUND_ORG = 0x11
const PREV_AROUND_DST = 0x33
const NEXT_AROUND_LEFT = 0x13
const PREV_AROUND_LEFT = 0x20

interface Point2f {
  x: number
  y: number
}

const point = (x: number, y: number): Point2f => ({ x: f(x), y: f(y) })

class QuadEdge {
  next = [0, 0, 0, 0]
  pt = [0, 0, 0, 0]

  static create(edgeidx: number): QuadEdge {
    const q = new QuadEdge()
    q.next = [edgeidx, edgeidx + 3, edgeidx + 2, edgeidx + 1]
    return q
  }
}

class Vertex {
  constructor(
    public pt: Point2f = { x: 0, y: 0 },
    public type = -1,
    public firstEdge = 0,
  ) {}
}

function triangleArea(a: Point2f, b: Point2f, c: Point2f): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function isPtInCircle3(pt: Point2f, a: Point2f, b: Point2f, c: Point2f): number {
  const eps = FLT_EPSILON * 0.125
  let val = (a.x * a.x + a.y * a.y) * triangleArea(b, c, pt)
  val -= (b.x * b.x + b.y * b.y) * triangleArea(a, c, pt)
  val += (c.x * c.x + c.y * c.y) * triangleArea(a, b, pt)
  val -= (pt.x * pt.x + pt.y * pt.y) * triangleArea(a, b, c)
  return val > eps ? 1 : val < -eps ? -1 : 0
}

export class Subdiv2D {
  private qedges: QuadEdge[] = []
  private vtx: Vertex[] = []
  private freeQEdge = 0
  private freePoint = 0
  private recentEdge = 0
  private topLeft: Point2f
  private bottomRight: Point2f

  /** Subdiv2D(Rect rect) with an integer rectangle. */
  constructor(rx: number, ry: number, width: number, height: number) {
    const bigCoord = f(6 * Math.max(width, height))
    const x = f(rx)
    const y = f(ry)
    this.topLeft = point(x, y)
    this.bottomRight = point(x + width, y + height)
    const ppA = point(x + bigCoord, y)
    const ppB = point(x, y + bigCoord)
    const ppC = point(x - bigCoord, y - bigCoord)
    this.vtx.push(new Vertex())
    this.qedges.push(new QuadEdge())
    this.freeQEdge = 0
    this.freePoint = 0
    const pA = this.newPoint(ppA)
    const pB = this.newPoint(ppB)
    const pC = this.newPoint(ppC)
    const edgeAB = this.newEdge()
    const edgeBC = this.newEdge()
    const edgeCA = this.newEdge()
    this.setEdgePoints(edgeAB, pA, pB)
    this.setEdgePoints(edgeBC, pB, pC)
    this.setEdgePoints(edgeCA, pC, pA)
    this.splice(edgeAB, this.symEdge(edgeCA))
    this.splice(edgeBC, this.symEdge(edgeAB))
    this.splice(edgeCA, this.symEdge(edgeBC))
    this.recentEdge = edgeAB
  }

  private nextEdge(edge: number): number {
    return this.qedges[edge >> 2]!.next[edge & 3]!
  }

  private rotateEdge(edge: number, rotate: number): number {
    return (edge & ~3) + ((edge + rotate) & 3)
  }

  private symEdge(edge: number): number {
    return edge ^ 2
  }

  private getEdge(edge: number, nextEdgeType: number): number {
    edge = this.qedges[edge >> 2]!.next[(edge + nextEdgeType) & 3]!
    return (edge & ~3) + ((edge + (nextEdgeType >> 4)) & 3)
  }

  private edgeOrg(edge: number): number {
    return this.qedges[edge >> 2]!.pt[edge & 3]!
  }

  private edgeDst(edge: number): number {
    return this.qedges[edge >> 2]!.pt[(edge + 2) & 3]!
  }

  private splice(edgeA: number, edgeB: number): void {
    const qa = this.qedges[edgeA >> 2]!
    const qb = this.qedges[edgeB >> 2]!
    const aRot = this.rotateEdge(qa.next[edgeA & 3]!, 1)
    const bRot = this.rotateEdge(qb.next[edgeB & 3]!, 1)
    const qar = this.qedges[aRot >> 2]!
    const qbr = this.qedges[bRot >> 2]!
    // std::swap of references bound before the first swap: the second swap reads the
    // slots after the first, in case they are the same
    const t1 = qa.next[edgeA & 3]!
    qa.next[edgeA & 3] = qb.next[edgeB & 3]!
    qb.next[edgeB & 3] = t1
    const t2 = qar.next[aRot & 3]!
    qar.next[aRot & 3] = qbr.next[bRot & 3]!
    qbr.next[bRot & 3] = t2
  }

  private setEdgePoints(edge: number, orgPt: number, dstPt: number): void {
    this.qedges[edge >> 2]!.pt[edge & 3] = orgPt
    this.qedges[edge >> 2]!.pt[(edge + 2) & 3] = dstPt
    this.vtx[orgPt]!.firstEdge = edge
    this.vtx[dstPt]!.firstEdge = edge ^ 2
  }

  private connectEdges(edgeA: number, edgeB: number): number {
    const edge = this.newEdge()
    this.splice(edge, this.getEdge(edgeA, NEXT_AROUND_LEFT))
    this.splice(this.symEdge(edge), edgeB)
    this.setEdgePoints(edge, this.edgeDst(edgeA), this.edgeOrg(edgeB))
    return edge
  }

  private swapEdges(edge: number): void {
    const sedge = this.symEdge(edge)
    const a = this.getEdge(edge, PREV_AROUND_ORG)
    const b = this.getEdge(sedge, PREV_AROUND_ORG)
    this.splice(edge, a)
    this.splice(sedge, b)
    this.setEdgePoints(edge, this.edgeDst(a), this.edgeDst(b))
    this.splice(edge, this.getEdge(a, NEXT_AROUND_LEFT))
    this.splice(sedge, this.getEdge(b, NEXT_AROUND_LEFT))
  }

  private isRightOf(pt: Point2f, edge: number): number {
    const org = this.vtx[this.edgeOrg(edge)]!.pt
    const dst = this.vtx[this.edgeDst(edge)]!.pt
    const cwArea = triangleArea(pt, dst, org)
    return Number(cwArea > 0) - Number(cwArea < 0)
  }

  private newEdge(): number {
    if (this.freeQEdge <= 0) {
      this.qedges.push(new QuadEdge())
      this.freeQEdge = this.qedges.length - 1
    }
    const edge = this.freeQEdge * 4
    this.freeQEdge = this.qedges[edge >> 2]!.next[1]!
    this.qedges[edge >> 2] = QuadEdge.create(edge)
    return edge
  }

  private deleteEdge(edge: number): void {
    this.splice(edge, this.getEdge(edge, PREV_AROUND_ORG))
    const sedge = this.symEdge(edge)
    this.splice(sedge, this.getEdge(sedge, PREV_AROUND_ORG))
    edge >>= 2
    this.qedges[edge]!.next[0] = 0
    this.qedges[edge]!.next[1] = this.freeQEdge
    this.freeQEdge = edge
  }

  private newPoint(pt: Point2f, isVirtual = false, firstEdge = 0): number {
    if (this.freePoint === 0) {
      this.vtx.push(new Vertex())
      this.freePoint = this.vtx.length - 1
    }
    const vidx = this.freePoint
    this.freePoint = this.vtx[vidx]!.firstEdge
    this.vtx[vidx] = new Vertex(pt, Number(isVirtual), firstEdge)
    return vidx
  }

  private locate(pt: Point2f): { location: number; edge: number; vertex: number } {
    let vertex = 0
    const maxEdges = this.qedges.length * 4
    if (this.qedges.length < 4) throw new Error('Subdivision is empty')
    if (pt.x < this.topLeft.x || pt.y < this.topLeft.y || pt.x >= this.bottomRight.x || pt.y >= this.bottomRight.y) {
      throw new Error('Subdiv2D: the point is outside the rectangle')
    }
    let edge = this.recentEdge
    if (!(edge > 0)) throw new Error('Subdiv2D: no recent edge')
    let location = PTLOC_ERROR
    let rightOfCurr = this.isRightOf(pt, edge)
    if (rightOfCurr > 0) {
      edge = this.symEdge(edge)
      rightOfCurr = -rightOfCurr
    }
    for (let i = 0; i < maxEdges; i++) {
      const onextEdge = this.nextEdge(edge)
      const dprevEdge = this.getEdge(edge, PREV_AROUND_DST)
      const rightOfOnext = this.isRightOf(pt, onextEdge)
      const rightOfDprev = this.isRightOf(pt, dprevEdge)
      if (rightOfDprev > 0) {
        if (rightOfOnext > 0 || (rightOfOnext === 0 && rightOfCurr === 0)) {
          location = PTLOC_INSIDE
          break
        } else {
          rightOfCurr = rightOfOnext
          edge = onextEdge
        }
      } else if (rightOfOnext > 0) {
        if (rightOfDprev === 0 && rightOfCurr === 0) {
          location = PTLOC_INSIDE
          break
        } else {
          rightOfCurr = rightOfDprev
          edge = dprevEdge
        }
      } else if (rightOfCurr === 0 && this.isRightOf(this.vtx[this.edgeDst(onextEdge)]!.pt, edge) >= 0) {
        edge = this.symEdge(edge)
      } else {
        rightOfCurr = rightOfOnext
        edge = onextEdge
      }
    }
    this.recentEdge = edge
    if (location === PTLOC_INSIDE) {
      const orgPt = this.vtx[this.edgeOrg(edge)]!.pt
      const dstPt = this.vtx[this.edgeDst(edge)]!.pt
      // The differences are float subtractions, then summed in double
      let t1 = Math.abs(f(pt.x - orgPt.x))
      t1 += Math.abs(f(pt.y - orgPt.y))
      let t2 = Math.abs(f(pt.x - dstPt.x))
      t2 += Math.abs(f(pt.y - dstPt.y))
      let t3 = Math.abs(f(orgPt.x - dstPt.x))
      t3 += Math.abs(f(orgPt.y - dstPt.y))
      if (t1 < FLT_EPSILON) {
        location = PTLOC_VERTEX
        vertex = this.edgeOrg(edge)
        edge = 0
      } else if (t2 < FLT_EPSILON) {
        location = PTLOC_VERTEX
        vertex = this.edgeDst(edge)
        edge = 0
      } else if ((t1 < t3 || t2 < t3) && Math.abs(triangleArea(pt, orgPt, dstPt)) < FLT_EPSILON) {
        location = PTLOC_ON_EDGE
        vertex = 0
      }
    }
    if (location === PTLOC_ERROR) {
      edge = 0
      vertex = 0
    }
    return { location, edge, vertex }
  }

  insert(x: number, y: number): number {
    const pt = point(x, y)
    let { location, edge: currEdge, vertex: currPoint } = this.locate(pt)
    if (location === PTLOC_ERROR) throw new Error('Subdiv2D: locate failed')
    if (location === PTLOC_VERTEX) return currPoint
    if (location === PTLOC_ON_EDGE) {
      const deletedEdge = currEdge
      this.recentEdge = currEdge = this.getEdge(currEdge, PREV_AROUND_ORG)
      this.deleteEdge(deletedEdge)
    } else if (location !== PTLOC_INSIDE) {
      throw new Error(`Subdiv2D::locate returned invalid location = ${location}`)
    }
    if (currEdge === 0) throw new Error('Subdiv2D: no edge')
    currPoint = this.newPoint(pt)
    let baseEdge = this.newEdge()
    const firstPoint = this.edgeOrg(currEdge)
    this.setEdgePoints(baseEdge, firstPoint, currPoint)
    this.splice(baseEdge, currEdge)
    do {
      baseEdge = this.connectEdges(currEdge, this.symEdge(baseEdge))
      currEdge = this.getEdge(baseEdge, PREV_AROUND_ORG)
    } while (this.edgeDst(currEdge) !== firstPoint)
    currEdge = this.getEdge(baseEdge, PREV_AROUND_ORG)
    const maxEdges = this.qedges.length * 4
    for (let i = 0; i < maxEdges; i++) {
      const tempEdge = this.getEdge(currEdge, PREV_AROUND_ORG)
      const tempDst = this.edgeDst(tempEdge)
      const currOrg = this.edgeOrg(currEdge)
      const currDst = this.edgeDst(currEdge)
      if (
        this.isRightOf(this.vtx[tempDst]!.pt, currEdge) > 0 &&
        isPtInCircle3(this.vtx[currOrg]!.pt, this.vtx[tempDst]!.pt, this.vtx[currDst]!.pt, this.vtx[currPoint]!.pt) < 0
      ) {
        this.swapEdges(currEdge)
        currEdge = this.getEdge(currEdge, PREV_AROUND_ORG)
      } else if (currOrg === firstPoint) {
        break
      } else {
        currEdge = this.getEdge(this.nextEdge(currEdge), PREV_AROUND_LEFT)
      }
    }
    return currPoint
  }

  /** The triangles within the rectangle, as [ax, ay, bx, by, cx, cy]. */
  getTriangleList(): number[][] {
    const result: number[][] = []
    const total = this.qedges.length * 4
    const edgemask = new Uint8Array(total)
    // Rect2f(topLeft, bottomRight - topLeft), contains() computed in float
    const rx = this.topLeft.x
    const ry = this.topLeft.y
    const rw = f(this.bottomRight.x - this.topLeft.x)
    const rh = f(this.bottomRight.y - this.topLeft.y)
    const right = f(rx + rw)
    const bottom = f(ry + rh)
    const contains = (p: Point2f) => rx <= p.x && p.x < right && ry <= p.y && p.y < bottom
    for (let i = 4; i < total; i += 2) {
      if (edgemask[i]) continue
      const edgeA = i
      const a = this.vtx[this.edgeOrg(edgeA)]!.pt
      if (!contains(a)) continue
      const edgeB = this.getEdge(edgeA, NEXT_AROUND_LEFT)
      const b = this.vtx[this.edgeOrg(edgeB)]!.pt
      if (!contains(b)) continue
      const edgeC = this.getEdge(edgeB, NEXT_AROUND_LEFT)
      const c = this.vtx[this.edgeOrg(edgeC)]!.pt
      if (!contains(c)) continue
      edgemask[edgeA] = 1
      edgemask[edgeB] = 1
      edgemask[edgeC] = 1
      result.push([a.x, a.y, b.x, b.y, c.x, c.y])
    }
    return result
  }
}
