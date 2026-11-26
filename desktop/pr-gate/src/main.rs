//! pr-gate: approval window shown before a session opens a pull request.
//!
//! `pr-gate --input in.json --output out.json` enqueues a request into a shared spool, makes
//! sure the window is up, and blocks until it is decided. Exit codes: 0 open, 10 draft,
//! 20 denied, 1 aborted. `pr-gate --daemon` is the single window showing every pending
//! request; it quits once the queue stays empty.
//! `pr-gate --preview --snap out.png --scene sample` renders the window headless.

mod client;
mod gate;
mod spool;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--preview") {
        gate::run(true);
    } else if args.iter().any(|a| a == "--daemon") {
        gate::run(false);
    } else {
        client::run();
    }
}
