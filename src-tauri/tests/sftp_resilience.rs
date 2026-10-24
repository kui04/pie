//! Resumable SFTP staging and multi-container resilience test suite.
//!
//! Tests deduplication, singleflight coalescing, breakpoint resumption, and
//! high-concurrency transfers against the Docker cluster.
//!
//! Run with:
//! ```text
//! eval "$(bash src-tauri/tests/scripts/sftp-cluster.sh start)"
//! cargo test --test sftp_resilience -- --ignored
//! bash src-tauri/tests/scripts/sftp-cluster.sh stop
//! ```

use std::{
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
};

use camino::Utf8Path;
use pie_lib::host::{Host, HostKey, SshAuth, SshTarget, Trust};
use russh::keys::PublicKeyOrCertificate;
use tokio::io::AsyncReadExt as _;

struct TrustAll;
impl HostKey for TrustAll {
    fn verify(
        &self,
        _host: &str,
        _port: u16,
        _key: &PublicKeyOrCertificate,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + '_>> {
        Box::pin(async { Ok(()) })
    }
}

#[derive(Debug)]
struct ClusterEnv {
    direct_addr: String,
    severable_addr: String,
    user: String,
    password: String,
    _key_path: PathBuf,
}

impl ClusterEnv {
    fn from_env() -> Self {
        let direct = std::env::var("PIE_SFTP_DIRECT_ADDR")
            .or_else(|_| std::env::var("PIE_SSH_TEST_ADDR"))
            .unwrap_or_else(|_| panic!("set PIE_SFTP_DIRECT_ADDR: eval \"$(tests/scripts/sftp-cluster.sh start)\""));
        let severable = std::env::var("PIE_SFTP_SEVERABLE_ADDR").unwrap_or_else(|_| direct.clone());
        let user = std::env::var("PIE_SSH_TEST_USER").unwrap_or_else(|_| "pie".to_string());
        let password = std::env::var("PIE_SSH_TEST_PASSWORD").unwrap_or_else(|_| "pie-test-password".to_string());
        let key_path = PathBuf::from(
            std::env::var("PIE_SSH_TEST_KEY").unwrap_or_else(|_| "/tmp/pie-ssh-fixture/id_ed25519".to_string()),
        );

        Self {
            direct_addr: direct,
            severable_addr: severable,
            user,
            password,
            _key_path: key_path,
        }
    }

    fn host_for(&self, addr: &str) -> Host {
        let (host, port) = addr.rsplit_once(':').expect("host:port");
        let port: u16 = port.parse().expect("port");
        let target = SshTarget::new(host, self.user.clone()).port(port);
        let auth = SshAuth::Password(self.password.clone());
        let trust = Trust::new(TrustAll);
        Host::ssh(target, auth, trust)
    }

    fn direct_host(&self) -> Host {
        self.host_for(&self.direct_addr)
    }

    fn severable_host(&self) -> Host {
        self.host_for(&self.severable_addr)
    }
}

#[tokio::test]
#[ignore = "requires sftp cluster"]
async fn sftp_stage_file_deduplication() {
    let env = ClusterEnv::from_env();
    let host = env.direct_host();
    host.connect().await.expect("connect");

    let temp = tempfile::tempdir().expect("temp dir");
    let file_path = temp.path().join("dedup_test.bin");
    let payload = vec![0x42u8; 512 * 1024];
    std::fs::write(&file_path, &payload).expect("write");
    let utf8_source = Utf8Path::from_path(&file_path).expect("utf8");

    let remote1 = host
        .files()
        .stage_file("sample", "bin", utf8_source, Box::new(|_, _| {}))
        .await
        .expect("first stage");

    let mut reported_on_second = (0, 0);
    let remote2 = host
        .files()
        .stage_file(
            "sample",
            "bin",
            utf8_source,
            Box::new(|transferred, total| {
                reported_on_second = (transferred, total);
            }),
        )
        .await
        .expect("second stage");

    assert_eq!(remote1, remote2);
    assert_eq!(reported_on_second, (payload.len() as u64, payload.len() as u64));

    host.close().await;
}

#[tokio::test]
#[ignore = "requires sftp cluster"]
async fn sftp_singleflight_coalescing() {
    let env = ClusterEnv::from_env();
    let host = Arc::new(env.direct_host());
    host.connect().await.expect("connect");

    let temp = tempfile::tempdir().expect("temp dir");
    let file_path = temp.path().join("singleflight.bin");
    let payload = vec![0x33u8; 1024 * 1024];
    std::fs::write(&file_path, &payload).expect("write");
    let utf8_source = Utf8Path::from_path(&file_path).expect("utf8").to_path_buf();

    let mut handles = Vec::new();
    for _ in 0..8 {
        let host_clone = Arc::clone(&host);
        let src_clone = utf8_source.clone();
        handles.push(tokio::spawn(async move {
            host_clone
                .files()
                .stage_file("concurrent", "bin", &src_clone, Box::new(|_, _| {}))
                .await
        }));
    }

    let mut paths = Vec::new();
    for handle in handles {
        let result = handle.await.expect("task completed").expect("stage succeeds");
        paths.push(result);
    }

    assert_eq!(paths.len(), 8);
    for path in &paths {
        assert_eq!(path, &paths[0]);
    }

    host.close().await;
}

#[tokio::test]
#[ignore = "requires sftp cluster"]
async fn sftp_distinct_filenames_same_payload_retain_independent_names() {
    let env = ClusterEnv::from_env();
    let host = Arc::new(env.direct_host());
    host.connect().await.expect("connect");

    let temp = tempfile::tempdir().expect("temp dir");
    let file_path = temp.path().join("shared_content.bin");
    let payload = vec![0x42u8; 512 * 1024];
    std::fs::write(&file_path, &payload).expect("write");
    let utf8_source = Utf8Path::from_path(&file_path).expect("utf8").to_path_buf();

    let host1 = Arc::clone(&host);
    let src1 = utf8_source.clone();
    let handle1 = tokio::spawn(async move {
        host1
            .files()
            .stage_file("file_alpha", "png", &src1, Box::new(|_, _| {}))
            .await
    });

    let host2 = Arc::clone(&host);
    let src2 = utf8_source.clone();
    let handle2 = tokio::spawn(async move {
        host2
            .files()
            .stage_file("file_beta", "jpg", &src2, Box::new(|_, _| {}))
            .await
    });

    let path1 = handle1.await.expect("task1").expect("stage1");
    let path2 = handle2.await.expect("task2").expect("stage2");

    assert!(
        path1.contains("file_alpha.png"),
        "path1 must retain file_alpha name: {path1}"
    );
    assert!(
        path2.contains("file_beta.jpg"),
        "path2 must retain file_beta name: {path2}"
    );
    assert_ne!(path1, path2);

    host.close().await;
}

#[tokio::test]
#[ignore = "requires sftp cluster"]
async fn sftp_resumable_upload_from_interrupted_part() {
    let env = ClusterEnv::from_env();
    let host = env.severable_host();
    host.connect().await.expect("connect");

    let temp = tempfile::tempdir().expect("temp dir");
    let file_path = temp.path().join("resumable.bin");
    let mut payload = Vec::with_capacity(2 * 1024 * 1024);
    for i in 0..(2 * 1024 * 1024) {
        payload.push((i % 251) as u8);
    }
    std::fs::write(&file_path, &payload).expect("write");
    let utf8_source = Utf8Path::from_path(&file_path).expect("utf8");

    let (digest, total_size) = pie_lib::host::digest_file(utf8_source).await.expect("digest");
    let cache_dir = host.files().cache_dir().await.expect("cache dir");
    host.files().create_dir_all(&cache_dir).await.expect("create cache dir");

    let staged_name = pie_lib::host::staged_name(&digest, "resumable", "bin");
    let part_path = format!("{cache_dir}/.{staged_name}.part");

    // Pre-seed remote .part with half the bytes
    let half_len = 1024 * 1024;
    {
        let host_ssh = env.severable_host();
        host_ssh.connect().await.expect("connect ssh");
        let remote_opened = host_ssh.files().open(&cache_dir).await;
        drop(remote_opened);
        let temp_local_file = temp.path().join("half.bin");
        std::fs::write(&temp_local_file, &payload[..half_len]).expect("write half");
        let utf8_half = Utf8Path::from_path(&temp_local_file).expect("utf8 half");
        // Stage the half file into the part path directly
        let half_staged = host_ssh
            .files()
            .stage_file("part_test", "bin", utf8_half, Box::new(|_, _| {}))
            .await
            .expect("stage half");
        // Rename half to part_path
        host_ssh.files().remove_file(&part_path).await.ok();
        let cmd = format!("cp -- '{}' '{}'", half_staged, part_path);
        host_ssh
            .exec()
            .output(pie_lib::host::Command::new("sh").args(["-c", &cmd]))
            .await
            .expect("copy part");
        host_ssh.close().await;
    }

    // Now resume stage_file
    let progress_recorded = Arc::new(Mutex::new(Vec::new()));
    let prog_clone = Arc::clone(&progress_recorded);
    let staged_path = host
        .files()
        .stage_file(
            "resumable",
            "bin",
            utf8_source,
            Box::new(move |transferred, total| {
                prog_clone.lock().unwrap().push((transferred, total));
            }),
        )
        .await
        .expect("stage resumed");

    // Verify progress started at or above half
    let prog = progress_recorded.lock().unwrap().clone();
    assert!(!prog.is_empty());
    assert!(
        prog[0].0 >= half_len as u64,
        "upload resumed from existing partial offset"
    );

    // Verify file content matches
    let mut reader = host.files().open(&staged_path).await.expect("open staged");
    let mut downloaded = Vec::new();
    reader.read_to_end(&mut downloaded).await.expect("read to end");
    assert_eq!(downloaded.len(), total_size as usize);
    assert_eq!(downloaded, payload);

    host.close().await;
}

#[tokio::test]
#[ignore = "requires sftp cluster"]
async fn sftp_high_concurrency_distinct_files() {
    let env = ClusterEnv::from_env();
    let host = Arc::new(env.direct_host());
    host.connect().await.expect("connect");

    let temp = tempfile::tempdir().expect("temp dir");
    let mut handles = Vec::new();

    for i in 0..12 {
        let host_clone = Arc::clone(&host);
        let file_path = temp.path().join(format!("file_{i}.bin"));
        let payload = vec![i as u8; 256 * 1024];
        std::fs::write(&file_path, payload).expect("write");
        let utf8_source = Utf8Path::from_path(&file_path).expect("utf8").to_path_buf();
        let name = format!("file_{i}");

        handles.push(tokio::spawn(async move {
            host_clone
                .files()
                .stage_file(&name, "bin", &utf8_source, Box::new(|_, _| {}))
                .await
        }));
    }

    for handle in handles {
        let res = handle.await.expect("task completed").expect("stage completed cleanly");
        assert!(!res.is_empty());
    }

    host.close().await;
}
