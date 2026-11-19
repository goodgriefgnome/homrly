\version "2.24.0"

\header {
  tagline = ##f
}

\score {
  <<
    \new PianoStaff <<
      \new Staff = "1" <<
        \new Voice = "1-1" {
          \key g \major \time 3/4 \clef treble d''4 b'8[ c''8 d''8 e''8] |
          d''4 g'4 g'4 |
          e''4 c''8[ d''8 e''8 fis''8] |
          g''2. |
          c''4 d''8[ c''8 b'8 a'8] |
          b'4 c''8[ b'8 a'8 g'8] |
          \break fis'4 g'8[ a'8 b'8 fis'8] |
          g'2 r4 |
          b'8([ a'8) b'8( c''8)] d''4 |
          e''8([ d''8) c''8( b'8)] a'4 |
          d'4 e'4 fis'4 |
          g'2. \bar "|." |
        }
      >>
      \new Staff = "2" <<
        \new Voice = "2-1" {
          \key g \major \time 3/4 \clef bass <g b>2. |
          b,2 g,4 |
          c2. |
          b,4 d4 g4 |
          a,2 d4 |
          g,2 b,4 |
          d2 c4 |
          b,4 g,4 r4 |
          g2 fis4 |
          e2 c4 |
          d2 d,4 |
          g,2. |
        }
      >>
    >>
  >>
  \layout { }
}
