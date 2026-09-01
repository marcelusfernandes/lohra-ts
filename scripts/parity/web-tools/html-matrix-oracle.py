"""Differential probe: oracle html.unescape vs a candidate matrix."""
import html
import json

matrix = [
    "A &NotEqualTilde; B",
    "A &#128; B",
    "A &#x80; B",
    "A &#0; B",
    "A &#x0; B",
    "A &#x7f; B",
    "A &#x81; B",
    "A &#55296; B",
    "A &#1114112; B",
    "A &#xfffe; B",
    "A &amp B",
    "A &ampx B",
    "A &notit; B",
    "A &notin; B",
    "A &amp; B",
    "A &lt;tag&gt; B",
    "A &Nope; B",
    "A & &amp &AMP B",
    "A &#x1F600; B",
    "A &CounterClockwiseContourIntegral; B",
    "A &not; B",
    "A &not a B",
    "A &ctdot; B",
    "A &acE; B",
    "A &bnequiv; B",
]
print(json.dumps({text: html.unescape(text) for text in matrix}))
