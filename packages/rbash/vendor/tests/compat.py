#!/usr/bin/env python3
"""Run each script through GNU bash (in a fresh temp dir) and rust-bash; diff stdout + exit code."""
import os, subprocess, sys, tempfile, json

RBASH = os.path.join(os.path.dirname(__file__), "..", "target", "release", "rbash")

CASES = [
    # --- basics
    ("echo", "echo hello world"),
    ("echo -n", "echo -n hi; echo there"),
    ("echo -e", r"echo -e 'a\tb\nc'"),
    ("quotes", """echo 'single $HOME' "double" mixed'q'"q" """),
    ("vars", "x=5; y=hello; echo $x $y ${y}!"),
    ("var default", "echo ${unset:-fallback} ${unset:=set}; echo $unset"),
    ("var alt", "a=1; echo ${a:+yes} ${b:+no}end"),
    ("var length", "s=hello; echo ${#s}"),
    ("prefix strip", "f=dir/sub/file.tar.gz; echo ${f#*/} ${f##*/} ${f%.*} ${f%%.*}"),
    ("replace", "s=foo-bar-baz; echo ${s/-/_} ${s//-/_} ${s/#foo/X} ${s/%baz/Y}"),
    ("substring", "s=abcdef; echo ${s:2} ${s:1:3} ${s: -2}"),
    ("case mod", "s=hello; echo ${s^^} ${s^} ; t=WORLD; echo ${t,,}"),
    ("arith", "echo $((2+3*4)) $((10/3)) $((10%3)) $((2**10)) $(( (1+2) * 3 ))"),
    ("arith vars", "a=7; b=3; echo $((a*b)) $((a>b)) $((a==7 ? 100 : 0))"),
    ("arith assign", "i=0; ((i++)); ((i+=5)); echo $i"),
    ("cmd subst", "x=$(echo inner); echo \"got $x\"; echo `echo back`"),
    ("nested subst", "echo $(echo $(echo deep))"),
    ("exit status", "false; echo $?; true; echo $?"),
    ("and or", "true && echo yes; false && echo no; false || echo fallback"),
    ("negation", "! false && echo negated"),
    ("brace expand", "echo {a,b,c}.txt; echo {1..5}; echo x{1..3}y"),
    ("brace seq step", "echo {0..10..3} {c..a}"),
    ("tilde", "echo ~ | grep -c /"),
    ("field split", "v='a  b   c'; for w in $v; do echo \"[$w]\"; done"),
    ("quoted no split", "v='a  b'; for w in \"$v\"; do echo \"[$w]\"; done"),
    ("positional", "set -- one two three; echo $# $1 $3; shift; echo $@"),
    ("dollar at", "f() { for a in \"$@\"; do echo \"<$a>\"; done; }; f 'x y' z"),
    # --- control flow
    ("if", "if [ 3 -gt 2 ]; then echo big; else echo small; fi"),
    ("elif", "x=5; if [ $x -lt 3 ]; then echo a; elif [ $x -lt 10 ]; then echo b; else echo c; fi"),
    ("for", "for i in 1 2 3; do echo item $i; done"),
    ("for brace", "for i in {1..3}; do printf '%s,' $i; done; echo"),
    ("c for", "for ((i=0; i<3; i++)); do echo $i; done"),
    ("while", "i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done"),
    ("until", "i=0; until [ $i -ge 2 ]; do echo u$i; i=$((i+1)); done"),
    ("break continue", "for i in 1 2 3 4 5; do [ $i = 2 ] && continue; [ $i = 4 ] && break; echo $i; done"),
    ("case", "for f in a.txt b.md c.rs; do case $f in *.txt) echo text;; *.md|*.rst) echo doc;; *) echo other;; esac; done"),
    ("function", "greet() { echo \"hi $1\"; return 3; }; greet bob; echo $?"),
    ("local", "x=global; f() { local x=inner; echo $x; }; f; echo $x"),
    ("recursion", "fact() { if [ $1 -le 1 ]; then echo 1; else echo $(( $1 * $(fact $(($1-1))) )); fi; }; fact 6"),
    ("subshell", "x=1; (x=2; echo in $x); echo out $x"),
    ("brace group", "{ echo a; echo b; } | wc -l"),
    ("[[ ]]", "s=hello.txt; [[ $s == *.txt ]] && echo match; [[ -z '' && -n x ]] && echo ok"),
    ("[[ regex ]]", "[[ abc123 =~ ^[a-z]+[0-9]+$ ]] && echo re-ok"),
    ("test ops", "[ abc = abc ] && echo eq; [ 1 -ne 2 ] && echo ne; [ -n '' ] || echo empty"),
    # --- redirects and pipes
    ("redirect", "echo one > f.txt; echo two >> f.txt; cat f.txt"),
    ("stdin redirect", "printf 'b\\na\\nc\\n' > in.txt; sort < in.txt"),
    ("stderr redirect", "ls /nope 2> err.txt; grep -c 'No such' err.txt"),
    ("2>&1", "ls /nope 2>&1 | grep -c 'No such'"),
    ("dev null", "ls /nope 2>/dev/null; echo code $?"),
    ("heredoc", "cat <<EOF\nline1\nvalue=$((1+1))\nEOF"),
    ("heredoc quoted", "cat <<'EOF'\nno $expansion here\nEOF"),
    ("herestring", "tr a-z A-Z <<< 'shout'"),
    ("pipeline", "echo -e 'c\\na\\nb\\na' | sort | uniq -c | sort -rn | head -1"),
    ("read loop", "printf 'x 1\\ny 2\\n' | while read k v; do echo \"$v=$k\"; done"),
    # --- files
    ("mkdir ls", "mkdir -p a/b/c; touch a/one a/two; ls a"),
    ("ls -R", "mkdir -p r/s; touch r/f r/s/g; ls -R r"),
    ("cp mv rm", "echo data > x; cp x y; mv y z; cat z; rm x z; ls x 2>/dev/null || echo gone"),
    ("cp -r", "mkdir -p src/d; echo 1 > src/d/f; cp -r src dst; cat dst/d/f"),
    ("glob", "mkdir g; touch g/a.txt g/b.txt g/c.md; echo g/*.txt; ls g/*.md"),
    ("glob no match", "echo nomatch*.zzz"),
    ("find", "mkdir -p p/q; touch p/1.rs p/q/2.rs p/q/3.txt; find p -name '*.rs' | sort"),
    ("find type", "mkdir -p t/u; touch t/f; find t -type d | sort"),
    ("test -f -d", "touch ff; mkdir dd; [ -f ff ] && echo file; [ -d dd ] && echo dir; [ -e nope ] || echo missing"),
    # --- text tools
    ("grep basic", "printf 'apple\\nbanana\\ncherry\\n' > fr; grep an fr; grep -c a fr; grep -v a fr"),
    ("grep -i -n", "printf 'Foo\\nbar\\nFOO\\n' | grep -in foo"),
    ("grep -E -o", "echo 'id=42 id=7 x=1' | grep -oE 'id=[0-9]+'"),
    ("grep -r", "mkdir -p rr/s; echo needle > rr/a; echo hay > rr/s/b; echo needle2 > rr/s/c; grep -r needle rr | sort"),
    ("grep -l -q", "echo hit > g1; echo miss > g2; grep -l hit g1 g2; grep -q hit g1 && echo quiet-ok"),
    ("grep BRE", "echo 'aaa bbb' | grep 'a\\{3\\}'"),
    ("sed s", "echo 'hello world' | sed 's/o/0/g'"),
    ("sed groups", "echo 'john smith' | sed -E 's/([a-z]+) ([a-z]+)/\\2, \\1/'"),
    ("sed addr", "seq 1 6 | sed -n '2,4p'"),
    ("sed delete", "seq 1 5 | sed '/3/d'"),
    ("sed -i", "printf 'a\\nb\\n' > s.txt; sed -i 's/a/A/' s.txt; cat s.txt"),
    ("sed multi", "echo abc | sed -e 's/a/1/' -e 's/c/3/'"),
    ("cut", "echo 'a:b:c:d' | cut -d: -f2,4; echo hello | cut -c2-4"),
    ("tr", "echo hello | tr a-z A-Z; echo 'a  b   c' | tr -s ' '; echo hello | tr -d l"),
    ("sort opts", "printf '10\\n9\\n100\\n' | sort -n; printf 'b\\na\\nb\\n' | sort -u; printf 'x 3\\ny 1\\nz 2\\n' | sort -k2 -n"),
    ("uniq", "printf 'a\\na\\nb\\nc\\nc\\nc\\n' | uniq -c"),
    ("head tail", "seq 1 20 > n; head -3 n; tail -2 n; tail -n +19 n"),
    ("wc", "printf 'one two\\nthree\\n' > w; wc -l w; wc -w < w; cat w | wc -c"),
    ("seq", "seq 3; seq 2 2 8; seq -s , 1 4"),
    ("printf", "printf '%s=%d\\n' a 1 b 2; printf '%5s|%-5s|%05d|%.2f\\n' x y 42 3.14159"),
    ("basename dirname", "basename /a/b/c.txt; basename /a/b/c.txt .txt; dirname /a/b/c.txt"),
    ("tee", "echo teed | tee t1 > /dev/null; cat t1"),
    ("xargs", "echo a b c | xargs echo got; printf '1\\n2\\n3\\n' | xargs -n 1 echo n"),
    ("rev tac", "echo abc | rev; printf '1\\n2\\n3\\n' | tac"),
    ("paste", "printf '1\\n2\\n' > p1; printf 'a\\nb\\n' > p2; paste -d, p1 p2"),
    # --- jq
    ("jq field", "echo '{\"name\":\"x\",\"n\":3}' | jq -r .name"),
    ("jq map", "echo '[1,2,3]' | jq -c 'map(.*2)'"),
    ("jq select", "echo '[{\"a\":1},{\"a\":5}]' | jq -c '.[] | select(.a > 2)'"),
    ("jq pretty", "echo '{\"a\":[1,{\"b\":2}]}' | jq ."),
    ("jq keys length", "echo '{\"b\":1,\"a\":2}' | jq -c 'keys, length'"),
    ("jq arg", "jq -n --arg v hi '{greeting: $v}' -c"),
    ("jq slurp", "printf '1\\n2\\n3\\n' | jq -s add"),
    ("jq strings", "echo '\"Hello\"' | jq -r 'ascii_downcase + \"!\"'"),
    # --- agent-ish
    ("agent pipeline", """mkdir -p proj/src; printf 'fn main() {}\\n// TODO: x\\n' > proj/src/main.rs; printf '// TODO: y\\n// TODO: z\\n' > proj/src/lib.rs
grep -rn TODO proj | sort | awk_free=1 cut -d: -f1 | sort | uniq -c | sort -rn"""),
    ("json report", """echo '[{"f":"a.rs","n":3},{"f":"b.rs","n":9}]' > r.json
total=$(jq '[.[].n] | add' r.json); top=$(jq -r 'max_by(.n).f' r.json); echo "total=$total top=$top" """),
    ("script file", "printf 'echo from script $1\\n' > s.sh; bash s.sh arg1"),
    ("eval", "cmd='echo evaluated'; eval $cmd"),
    ("command not found", "nosuchcmd; echo $?"),
    ("syntax error", "if then fi"),
]


def run_bash(script):
    with tempfile.TemporaryDirectory() as d:
        r = subprocess.run(["bash", "-c", script], cwd=d, capture_output=True, text=True, timeout=10,
                           env={"PATH": os.environ["PATH"], "HOME": "/home/user", "LC_ALL": "C"})
        return r.stdout, r.returncode


def run_rbash(script):
    r = subprocess.run([RBASH, "-c", script], capture_output=True, text=True, timeout=10)
    return r.stdout, r.returncode


def main():
    passed, failed = 0, []
    for name, script in CASES:
        b = run_bash(script)
        r = run_rbash(script)
        # syntax errors: just require a non-zero exit from both
        ok = (b == r) or (name == "syntax error" and b[1] != 0 and r[1] != 0)
        if ok:
            passed += 1
        else:
            failed.append((name, script, b, r))
    for name, script, b, r in failed:
        print(f"FAIL {name}\n  script: {script!r}\n  bash:   {repr(b)[:300]}\n  rbash:  {repr(r)[:300]}")
    print(f"\n{passed}/{len(CASES)} cases match GNU bash")
    json.dump({"passed": passed, "total": len(CASES), "failed": [f[0] for f in failed]},
              open(os.path.join(os.path.dirname(__file__), "compat-result.json"), "w"))
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    main()
