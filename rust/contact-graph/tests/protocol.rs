use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn worker_survives_malformed_line_and_replies_to_next_health_request() {
    let database = tempfile::tempdir().unwrap();
    let path = database.path().join("contacts.sqlite");
    let mut child = Command::new(env!("CARGO_BIN_EXE_contact-graph"))
        .env("CONTACT_GRAPH_SQLITE_PATH", &path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "not json").unwrap();
    writeln!(
        stdin,
        "{}",
        json!({"version":1,"request_id":"req-1","op":"health","payload":{"nonce":"ok"}})
    )
    .unwrap();
    writeln!(
        stdin,
        "{}",
        json!({"version":1,"request_id":"req-2","op":"unknown","payload":{}})
    )
    .unwrap();
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "worker stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let frames: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(frames.len(), 3);
    assert_eq!(frames[0]["ok"], false);
    assert_eq!(frames[1]["request_id"], "req-1");
    assert_eq!(frames[1]["result"]["nonce"], "ok");
    assert_eq!(frames[2]["error"]["code"], "UNKNOWN_OPERATION");
}
