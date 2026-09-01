# Third-party notices

## pdf-lib 1.17.1

- Purpose: browser-side PDF creation
- Source: https://github.com/Hopding/pdf-lib
- License: MIT
- Bundled file: `pdf-lib.min.js`
- License text: `pdf-lib-LICENSE.md`

## @pdf-lib/fontkit 1.1.1

- Purpose: embedding the Japanese TrueType font in PDF files
- Source: https://github.com/Hopding/fontkit
- License: MIT
- Bundled file: `fontkit.umd.min.js`

MIT License

Copyright (c) 2019 Andrew Dillon and contributors

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

## Noto Sans CJK JP Regular 2.004

- Purpose: embedded Japanese font for generated PDF files
- Source: https://github.com/notofonts/noto-cjk
- License: SIL Open Font License 1.1
- Bundled files: `NotoSansCJKjp-Regular.ttf`, `NotoSansCJKjp-PdfCommon.ttf`, `pdf-font-data.js`
- Build note: this static Regular instance was generated locally from the official `NotoSansCJKjp-VF.ttf` source at weight 400 using FontTools 4.59.0.
- License text: `NotoSansJP-LICENSE.txt`
- `NotoSansCJKjp-PdfCommon.ttf` is a build-time subset containing CP932 characters and report fixed text. It retains a normal cmap and is embedded without runtime subsetting for iOS PDF compatibility.
- `pdf-font-data.js` contains the same pre-subset font as Base64 so normal PDF generation does not require an additional runtime fetch. The full font is retained as a fallback for characters outside the pre-subset.
