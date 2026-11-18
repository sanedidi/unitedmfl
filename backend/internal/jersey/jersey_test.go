package jersey

import (
	"encoding/json"
	"sort"
	"testing"
)

func TestParse(t *testing.T) {
	ok := map[string]Number{"10": "10", "z 10": "Z10", " Z10 ": "Z10", "07": "7", "0": "0", "00": "0", "7a": "7A", "": "", "  ": "", "я1": "Я1", "0099": "99", "Z007": "Z007"}
	for in, want := range ok {
		if got, valid := Parse(in); !valid || got != want {
			t.Errorf("Parse(%q) = %q %v, want %q", in, got, valid, want)
		}
	}
	for _, in := range []string{"12345", "ABCDE", "1-0", "#10", "1.5", "-1", "z_1"} {
		if got, valid := Parse(in); valid {
			t.Errorf("Parse(%q) = %q, must be invalid", in, got)
		}
	}
}

func TestJSON(t *testing.T) {
	var v struct {
		A, B, C, D Number
	}
	if err := json.Unmarshal([]byte(`{"A": 10, "B": "z 10", "C": null, "D": ""}`), &v); err != nil {
		t.Fatal(err)
	}
	if v.A != "10" || v.B != "Z10" || v.C != "" || v.D != "" {
		t.Fatalf("decoded %+v", v)
	}
	out, _ := json.Marshal(v)
	if string(out) != `{"A":"10","B":"Z10","C":null,"D":null}` {
		t.Fatalf("encoded %s", out)
	}
	if err := json.Unmarshal([]byte(`{"A": "TOOLONG"}`), &v); err == nil {
		t.Fatal("a long number must be rejected")
	}
	if err := json.Unmarshal([]byte(`{"A": 1.5}`), &v); err == nil {
		t.Fatal("a fraction must be rejected")
	}
}

func TestOrder(t *testing.T) {
	ns := []Number{"Z10", "", "10", "2", "A", "1", "10B"}
	sort.SliceStable(ns, func(i, j int) bool { return Less(ns[i], ns[j]) })
	want := []Number{"1", "2", "10", "10B", "Z10", "A", ""}
	for i := range want {
		if ns[i] != want[i] {
			t.Fatalf("order %q, want %q", ns, want)
		}
	}
}
