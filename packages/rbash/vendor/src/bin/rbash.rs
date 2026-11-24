use std::io::Read;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let script = if args.len() > 2 && args[1] == "-c" {
        args[2].clone()
    } else {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).unwrap();
        s
    };
    let mut sh = rust_bash::Shell::new();
    let r = sh.exec(&script);
    print!("{}", r.stdout);
    eprint!("{}", r.stderr);
    std::process::exit(r.exit_code);
}
