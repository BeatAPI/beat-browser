# Third-party notices

## huashu-chrome

BeatBrowser builds on the open-source MCP, local bridge, Chrome extension and
site-learning foundation from
[alchaincyf/huashu-chrome](https://github.com/alchaincyf/huashu-chrome). The
upstream author remains credited in `LICENSE`. BeatBrowser's dual Normal/Fast
JEV product structure and the Fast executor described below are BeatAPI
adaptations; no affiliation beyond the open-source lineage is implied.

## jev-ultrafast

The optional JEV fast executor is inspired by and adapts design and validation
patterns from [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast),
reviewed at commit `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`.
Relevant upstream concepts include dynamic finite action spaces, speculative
target heads, strict choice/probability validation and the bounded
observe/decide/act loop. The adapted JavaScript implementation lives under
`src/fast-agent/` with extension-side bounded execution support.

The [Browser Use repository](https://github.com/browser-use/browser-use),
reviewed at commit `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`, was consulted as an
architecture reference for registry, state and runner responsibilities. This
project does not bundle its Python runtime or add its dependencies.

BeatAPI and BeatBrowser do not claim an official partnership, sponsorship or
endorsement from Browser Use or TypeSafe. Upstream performance examples are
not BeatBrowser benchmarks.

The jev-ultrafast MIT license is reproduced below in full:

```text
MIT License

Copyright (c) 2026 Browser Use

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
