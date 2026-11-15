package xlsx

import (
	"archive/zip"
	"bytes"
	"testing"
)

// A workbook as Excel writes it: shared strings, numbers, a gap in the row and
// a picture in xl/media.
func TestReadSharedStrings(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	put := func(name, body string) {
		w, _ := zw.Create(name)
		w.Write([]byte(body))
	}
	put("xl/workbook.xml", `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Лист1" sheetId="1" r:id="rId7"/></sheets></workbook>`)
	put("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="worksheet" Target="worksheets/sheet3.xml"/></Relationships>`)
	put("xl/sharedStrings.xml", `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>ISM</t></si><si><r><t>Fami</t></r><r><t>liya</t></r></si></sst>`)
	put("xl/worksheets/sheet3.xml", `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
		<row r="2"><c r="B2" t="s"><v>0</v></c><c r="D2" t="s"><v>1</v></c></row>
		<row r="3"><c r="A3"><v>17</v></c><c r="C3" t="inlineStr"><is><t>inline</t></is></c></row></sheetData></worksheet>`)
	put("xl/media/image1.png", "\x89PNG fake")
	zw.Close()

	wb, err := Read(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(wb.Rows) != 3 || len(wb.Rows[0]) != 0 {
		t.Fatalf("rows: %#v", wb.Rows)
	}
	if got := wb.Rows[1]; len(got) != 4 || got[1] != "ISM" || got[3] != "Familiya" || got[0] != "" {
		t.Fatalf("row 2: %#v", got)
	}
	if got := wb.Rows[2]; got[0] != "17" || got[2] != "inline" {
		t.Fatalf("row 3: %#v", got)
	}
	if len(wb.Images) != 1 || wb.Images[0].Name != "image1.png" {
		t.Fatalf("images: %+v", wb.Images)
	}
}

func TestWriteRead(t *testing.T) {
	b, err := Write(Sheet{Name: "Tarkib & co", Widths: []float64{6, 20}, Rows: [][]Cell{{{Text: "№", Bold: true}, {Text: "ISM <a>", Bold: true}}, {{Text: "1"}, {Text: "O‘tkir"}}}})
	if err != nil {
		t.Fatal(err)
	}
	wb, err := Read(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	if wb.Rows[0][1] != "ISM <a>" || wb.Rows[1][1] != "O‘tkir" {
		t.Fatalf("%#v", wb.Rows)
	}
}

func TestNotXLSX(t *testing.T) {
	if _, err := Read(bytes.NewReader([]byte("hello")), 5); err != ErrNotXLSX {
		t.Fatalf("err = %v", err)
	}
}

func TestColName(t *testing.T) {
	for i, want := range map[int]string{0: "A", 25: "Z", 26: "AA", 27: "AB"} {
		if got := ColName(i); got != want {
			t.Errorf("ColName(%d) = %s", i, got)
		}
		if got, _ := colIndex(want + "5"); got != i {
			t.Errorf("colIndex(%s) = %d", want, got)
		}
	}
}
