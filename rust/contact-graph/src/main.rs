use contact_graph::protocol::{frame_too_large, parse_and_dispatch};
use contact_graph::store::Store;
use std::io::{self, BufRead, Write};

const MAX_FRAME_BYTES: usize = 256 * 1024;

fn next_line(reader: &mut impl BufRead) -> io::Result<Option<(Vec<u8>, bool)>> {
    let mut line = Vec::new();
    let mut too_large = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some((line, too_large)))
            };
        }
        let end = available.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(available.len(), |position| position + 1);
        if !too_large {
            let remaining = MAX_FRAME_BYTES.saturating_add(1).saturating_sub(line.len());
            line.extend_from_slice(&available[..count.min(remaining)]);
            if line.len() > MAX_FRAME_BYTES {
                too_large = true;
            }
        }
        reader.consume(count);
        if end.is_some() {
            return Ok(Some((line, too_large)));
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::var("CONTACT_GRAPH_SQLITE_PATH")?;
    let store = Store::open(path)?;
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    while let Some((line, too_large)) = next_line(&mut reader)? {
        let response = if too_large {
            frame_too_large()
        } else {
            parse_and_dispatch(&line, &store)
        };
        serde_json::to_writer(&mut writer, &response)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
    Ok(())
}
