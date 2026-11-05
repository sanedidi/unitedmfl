package standings

import "testing"

func TestComputeGroupA(t *testing.T) {
	// Real group-A results published on unitedmfl.com.
	teams := []Team{{1, "A1", "a1", "A", true}, {2, "Avengers", "avengers", "A", true}, {3, "Tanish Bilish", "tanish-bilish", "A", true}, {4, "F-River", "f-river", "A", true}}
	res := []Result{
		{1, 4, 4, 0, 1}, // A1 4:0 F-River
		{3, 2, 3, 8, 2}, // Tanish Bilish 3:8 Avengers
		{1, 2, 2, 1, 3}, // A1 2:1 Avengers
		{3, 4, 3, 1, 4}, // Tanish Bilish 3:1 F-River
	}
	got := Compute(teams, res, nil, Rules{3, 1, 0})["A"]
	want := []struct {
		team    string
		pts, gd int
	}{{"A1", 6, 5}, {"Avengers", 3, 4}, {"Tanish Bilish", 3, -3}, {"F-River", 0, -6}}
	if len(got) != 4 {
		t.Fatalf("rows=%d", len(got))
	}
	for i, w := range want {
		if got[i].Team != w.team || got[i].Points != w.pts || got[i].GoalDiff != w.gd {
			t.Errorf("row %d = %+v, want %+v", i, got[i], w)
		}
	}
	if f := got[0].Form; len(f) != 2 || f[0] != "W" || f[1] != "W" {
		t.Errorf("A1 form = %v", f)
	}
}

func TestAdjustment(t *testing.T) {
	teams := []Team{{1, "X", "x", "A", false}, {2, "Y", "y", "A", false}}
	got := Compute(teams, []Result{{1, 2, 1, 1, 1}}, map[int64]int{2: -3}, Rules{3, 1, 0})["A"]
	if got[0].Team != "X" || got[1].Points != -2 {
		t.Fatalf("unexpected %+v", got)
	}
}
