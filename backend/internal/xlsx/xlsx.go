// Package xlsx reads the first sheet of an .xlsx workbook as a grid of strings
// and writes simple one-sheet workbooks. It covers what the team roster
// import/export needs (the league's TARKIB.xlsx) with the standard library only.
package xlsx

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"strconv"
	"strings"
)

// Limits guard against oversized or malicious archives.
const (
	maxPartBytes = 16 << 20 // one XML part, uncompressed
	maxImage     = 8 << 20
	maxRows      = 2000
	maxCols      = 60
)

// ErrNotXLSX is returned for files that are not an Excel 2007+ workbook.
var ErrNotXLSX = errors.New("fayl .xlsx formatida emas")

// Image is a picture embedded in the workbook (xl/media/*).
type Image struct {
	Name string
	Data []byte
}

// Workbook is the first sheet as rows of cell strings plus embedded images.
// Numeric cells are kept as Excel writes them (dates arrive as serial numbers).
type Workbook struct {
	Rows   [][]string
	Images []Image
}

// Read parses an .xlsx file.
func Read(r io.ReaderAt, size int64) (*Workbook, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, ErrNotXLSX
	}
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[strings.TrimPrefix(f.Name, "/")] = f
	}
	if files["xl/workbook.xml"] == nil {
		return nil, ErrNotXLSX
	}
	sheet, err := firstSheetPath(files)
	if err != nil {
		return nil, err
	}
	shared, err := sharedStrings(files["xl/sharedStrings.xml"])
	if err != nil {
		return nil, err
	}
	rows, err := readSheet(files[sheet], shared)
	if err != nil {
		return nil, err
	}
	wb := &Workbook{Rows: rows}
	for name, f := range files {
		if !strings.HasPrefix(name, "xl/media/") || f.UncompressedSize64 > maxImage {
			continue
		}
		if b, err := readPart(f, maxImage); err == nil && len(b) > 0 {
			wb.Images = append(wb.Images, Image{Name: path.Base(name), Data: b})
		}
	}
	return wb, nil
}

func readPart(f *zip.File, limit int64) ([]byte, error) {
	if f == nil {
		return nil, nil
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("fayl juda katta")
	}
	return b, nil
}

func firstSheetPath(files map[string]*zip.File) (string, error) {
	wbXML, err := readPart(files["xl/workbook.xml"], maxPartBytes)
	if err != nil {
		return "", err
	}
	var wb struct {
		Sheets []struct {
			RID string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
		} `xml:"sheets>sheet"`
	}
	if err := xml.Unmarshal(wbXML, &wb); err != nil || len(wb.Sheets) == 0 {
		return "", ErrNotXLSX
	}
	relsXML, _ := readPart(files["xl/_rels/workbook.xml.rels"], maxPartBytes)
	var rels struct {
		Rel []struct {
			ID     string `xml:"Id,attr"`
			Target string `xml:"Target,attr"`
		} `xml:"Relationship"`
	}
	_ = xml.Unmarshal(relsXML, &rels)
	for _, rel := range rels.Rel {
		if rel.ID == wb.Sheets[0].RID {
			t := rel.Target
			if strings.HasPrefix(t, "/") {
				t = strings.TrimPrefix(t, "/")
			} else {
				t = path.Join("xl", t)
			}
			if files[t] != nil {
				return t, nil
			}
		}
	}
	if files["xl/worksheets/sheet1.xml"] != nil {
		return "xl/worksheets/sheet1.xml", nil
	}
	return "", ErrNotXLSX
}

// richText collects the text of <si>/<is> (plain <t> or rich-text runs).
type richText struct {
	T string `xml:"t"`
	R []struct {
		T string `xml:"t"`
	} `xml:"r"`
}

func (r richText) String() string {
	if len(r.R) == 0 {
		return r.T
	}
	var b strings.Builder
	b.WriteString(r.T)
	for _, x := range r.R {
		b.WriteString(x.T)
	}
	return b.String()
}

func sharedStrings(f *zip.File) ([]string, error) {
	if f == nil {
		return nil, nil
	}
	b, err := readPart(f, maxPartBytes)
	if err != nil {
		return nil, err
	}
	var sst struct {
		SI []richText `xml:"si"`
	}
	if err := xml.Unmarshal(b, &sst); err != nil {
		return nil, ErrNotXLSX
	}
	out := make([]string, len(sst.SI))
	for i, si := range sst.SI {
		out[i] = si.String()
	}
	return out, nil
}

func readSheet(f *zip.File, shared []string) ([][]string, error) {
	b, err := readPart(f, maxPartBytes)
	if err != nil {
		return nil, err
	}
	var ws struct {
		Rows []struct {
			R     int `xml:"r,attr"`
			Cells []struct {
				Ref string    `xml:"r,attr"`
				T   string    `xml:"t,attr"`
				V   string    `xml:"v"`
				Is  *richText `xml:"is"`
			} `xml:"c"`
		} `xml:"sheetData>row"`
	}
	if err := xml.Unmarshal(b, &ws); err != nil {
		return nil, ErrNotXLSX
	}
	var rows [][]string
	next := 1
	for _, row := range ws.Rows {
		ri := row.R
		if ri <= 0 {
			ri = next
		}
		next = ri + 1
		if ri > maxRows {
			break
		}
		for len(rows) < ri {
			rows = append(rows, nil)
		}
		var cells []string
		col := 0
		for _, c := range row.Cells {
			if c.Ref != "" {
				if ci, ok := colIndex(c.Ref); ok {
					col = ci
				}
			}
			if col >= maxCols {
				break
			}
			var v string
			switch c.T {
			case "s":
				if i, err := strconv.Atoi(strings.TrimSpace(c.V)); err == nil && i >= 0 && i < len(shared) {
					v = shared[i]
				}
			case "inlineStr":
				if c.Is != nil {
					v = c.Is.String()
				}
			case "b":
				if c.V == "1" {
					v = "TRUE"
				} else {
					v = "FALSE"
				}
			default:
				v = c.V
			}
			for len(cells) <= col {
				cells = append(cells, "")
			}
			cells[col] = strings.TrimSpace(v)
			col++
		}
		rows[ri-1] = cells
	}
	return rows, nil
}

// colIndex turns "C12" into 2.
func colIndex(ref string) (int, bool) {
	n := 0
	i := 0
	for i < len(ref) && ref[i] >= 'A' && ref[i] <= 'Z' {
		n = n*26 + int(ref[i]-'A'+1)
		i++
	}
	if i == 0 {
		return 0, false
	}
	return n - 1, true
}

// ColName turns 0 into "A", 27 into "AB".
func ColName(i int) string {
	s := ""
	for i >= 0 {
		s = string(rune('A'+i%26)) + s
		i = i/26 - 1
	}
	return s
}

// ---------- writer ----------

// Cell is one written cell; Bold marks headers.
type Cell struct {
	Text string
	Bold bool
}

// Sheet is a one-sheet workbook to write.
type Sheet struct {
	Name   string
	Widths []float64 // column widths in characters (0 = default)
	Rows   [][]Cell
}

// Write renders the sheet as an .xlsx file. Cells are inline strings.
func Write(sh Sheet) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, body string) error {
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = io.WriteString(w, body)
		return err
	}
	name := sh.Name
	if name == "" {
		name = "Sheet1"
	}
	parts := []struct{ name, body string }{
		{"[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`},
		{"_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
		{"xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="` + esc(name) + `" sheetId="1" r:id="rId1"/></sheets></workbook>`},
		{"xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`},
		{"xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`},
		{"xl/worksheets/sheet1.xml", sheetXML(sh)},
	}
	for _, p := range parts {
		if err := add(p.name, p.body); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func sheetXML(sh Sheet) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`)
	if len(sh.Widths) > 0 {
		b.WriteString("<cols>")
		for i, w := range sh.Widths {
			if w > 0 {
				fmt.Fprintf(&b, `<col min="%d" max="%d" width="%.1f" customWidth="1"/>`, i+1, i+1, w)
			}
		}
		b.WriteString("</cols>")
	}
	b.WriteString("<sheetData>")
	for ri, row := range sh.Rows {
		fmt.Fprintf(&b, `<row r="%d">`, ri+1)
		for ci, c := range row {
			if c.Text == "" {
				continue
			}
			style := ""
			if c.Bold {
				style = ` s="1"`
			}
			fmt.Fprintf(&b, `<c r="%s%d" t="inlineStr"%s><is><t xml:space="preserve">%s</t></is></c>`, ColName(ci), ri+1, style, esc(c.Text))
		}
		b.WriteString("</row>")
	}
	b.WriteString("</sheetData></worksheet>")
	return b.String()
}

func esc(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
