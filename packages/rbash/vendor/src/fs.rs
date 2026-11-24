//! In-memory virtual filesystem. Every command reads and writes through this;
//! nothing ever touches the host disk.

use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub enum Node {
    File(Vec<u8>),
    Dir,
}

#[derive(Clone, Debug)]
pub struct MemFs {
    nodes: BTreeMap<String, Node>,
    /// Hard cap on total bytes stored, so a runaway script can't eat the heap.
    pub max_bytes: usize,
    used_bytes: usize,
}

impl Default for MemFs {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve `path` against `cwd` and normalise `.`/`..`/duplicate slashes.
pub fn normalize(cwd: &str, path: &str) -> String {
    let joined = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{}/{}", cwd.trim_end_matches('/'), path)
    };
    let mut parts: Vec<&str> = Vec::new();
    for p in joined.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

pub fn parent(path: &str) -> String {
    match path.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(i) => path[..i].to_string(),
    }
}

pub fn basename(path: &str) -> &str {
    let p = path.trim_end_matches('/');
    if p.is_empty() {
        return "/";
    }
    match p.rfind('/') {
        Some(i) => &p[i + 1..],
        None => p,
    }
}

impl MemFs {
    pub fn new() -> Self {
        let mut fs = MemFs {
            nodes: BTreeMap::new(),
            max_bytes: 256 * 1024 * 1024,
            used_bytes: 0,
        };
        for d in ["/", "/home", "/home/user", "/tmp", "/bin", "/usr", "/usr/bin"] {
            fs.nodes.insert(d.to_string(), Node::Dir);
        }
        fs
    }

    pub fn exists(&self, p: &str) -> bool {
        self.nodes.contains_key(p)
    }
    pub fn is_dir(&self, p: &str) -> bool {
        matches!(self.nodes.get(p), Some(Node::Dir))
    }
    pub fn is_file(&self, p: &str) -> bool {
        matches!(self.nodes.get(p), Some(Node::File(_)))
    }
    pub fn size(&self, p: &str) -> usize {
        match self.nodes.get(p) {
            Some(Node::File(d)) => d.len(),
            _ => 0,
        }
    }

    pub fn read(&self, p: &str) -> Result<&[u8], String> {
        match self.nodes.get(p) {
            Some(Node::File(d)) => Ok(d),
            Some(Node::Dir) => Err(format!("{}: Is a directory", p)),
            None => Err(format!("{}: No such file or directory", p)),
        }
    }

    pub fn write(&mut self, p: &str, data: &[u8], append: bool) -> Result<(), String> {
        if p == "/dev/null" {
            return Ok(());
        }
        let par = parent(p);
        if !self.is_dir(&par) {
            return Err(format!("{}: No such file or directory", p));
        }
        if self.is_dir(p) {
            return Err(format!("{}: Is a directory", p));
        }
        let old = self.size(p);
        let new_len = if append { old + data.len() } else { data.len() };
        if self.used_bytes - old + new_len > self.max_bytes {
            return Err(format!("{}: No space left on device", p));
        }
        self.used_bytes = self.used_bytes - old + new_len;
        match self.nodes.get_mut(p) {
            Some(Node::File(d)) if append => d.extend_from_slice(data),
            _ => {
                self.nodes.insert(p.to_string(), Node::File(data.to_vec()));
            }
        }
        Ok(())
    }

    pub fn mkdir(&mut self, p: &str, parents: bool) -> Result<(), String> {
        if self.exists(p) {
            if parents && self.is_dir(p) {
                return Ok(());
            }
            return Err(format!("cannot create directory '{}': File exists", p));
        }
        let par = parent(p);
        if !self.is_dir(&par) {
            if parents {
                self.mkdir(&par, true)?;
            } else {
                return Err(format!("cannot create directory '{}': No such file or directory", p));
            }
        }
        self.nodes.insert(p.to_string(), Node::Dir);
        Ok(())
    }

    /// Direct children names of a directory, sorted.
    pub fn list(&self, p: &str) -> Result<Vec<String>, String> {
        if !self.is_dir(p) {
            return Err(format!("{}: Not a directory", p));
        }
        let prefix = if p == "/" { "/".to_string() } else { format!("{}/", p) };
        Ok(self
            .nodes
            .range(prefix.clone()..)
            .take_while(|(k, _)| k.starts_with(&prefix))
            .filter_map(|(k, _)| {
                let rest = &k[prefix.len()..];
                if !rest.is_empty() && !rest.contains('/') {
                    Some(rest.to_string())
                } else {
                    None
                }
            })
            .collect())
    }

    /// All descendants (full paths), depth-first sorted.
    pub fn walk(&self, p: &str) -> Vec<String> {
        let prefix = if p == "/" { "/".to_string() } else { format!("{}/", p) };
        self.nodes
            .range(prefix.clone()..)
            .take_while(|(k, _)| k.starts_with(&prefix))
            .map(|(k, _)| k.clone())
            .filter(|k| k != "/")
            .collect()
    }

    pub fn remove(&mut self, p: &str, recursive: bool) -> Result<(), String> {
        if p == "/" {
            return Err("cannot remove '/'".into());
        }
        match self.nodes.get(p) {
            None => Err(format!("cannot remove '{}': No such file or directory", p)),
            Some(Node::Dir) => {
                let kids = self.walk(p);
                if !kids.is_empty() && !recursive {
                    return Err(format!("cannot remove '{}': Directory not empty", p));
                }
                for k in kids {
                    self.used_bytes -= self.size(&k);
                    self.nodes.remove(&k);
                }
                self.nodes.remove(p);
                Ok(())
            }
            Some(Node::File(_)) => {
                self.used_bytes -= self.size(p);
                self.nodes.remove(p);
                Ok(())
            }
        }
    }

    pub fn copy(&mut self, from: &str, to: &str, recursive: bool) -> Result<(), String> {
        match self.nodes.get(from).cloned() {
            None => Err(format!("cannot stat '{}': No such file or directory", from)),
            Some(Node::File(d)) => self.write(to, &d, false),
            Some(Node::Dir) => {
                if !recursive {
                    return Err(format!("-r not specified; omitting directory '{}'", from));
                }
                self.mkdir(to, true)?;
                for k in self.walk(from) {
                    let dest = format!("{}{}", to, &k[from.len()..]);
                    match self.nodes.get(&k).cloned() {
                        Some(Node::Dir) => self.mkdir(&dest, true)?,
                        Some(Node::File(d)) => self.write(&dest, &d, false)?,
                        None => {}
                    }
                }
                Ok(())
            }
        }
    }

    pub fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        self.copy(from, to, true)?;
        self.remove(from, true)
    }
}
