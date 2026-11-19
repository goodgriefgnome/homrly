% An original test score for homrly, written for this project.
\version "2.26.0"
\header { tagline = ##f }
\paper { #(set-paper-size "a4") }
upper = \relative c'' {
  \clef treble \key g \major \time 3/4
  d4 b8 c d e | d4 g, g | e'4 c8 d e fis | g2. |
  c,4 d8 c b a | b4 c8 b a g | fis4 g8 a b fis | g2 r4 |
  b8( a) b( c) d4 | e8( d) c( b) a4 | d,4 e fis | g2. \bar "|."
}
lower = \relative c' {
  \clef bass \key g \major \time 3/4
  <g b>2. | b,2 g4 | c2. | b4 d g |
  a,2 d4 | g,2 b4 | d2 c4 | b4 g r4 |
  g'2 fis4 | e2 c4 | d2 d,4 | g2. \bar "|."
}
\score { \new PianoStaff << \new Staff \upper \new Staff \lower >> \layout { } }
