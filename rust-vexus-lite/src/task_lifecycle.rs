use napi::{Env, Result, Task};
use std::sync::{Arc, Condvar, Mutex};

#[derive(Default)]
pub(crate) struct TaskLifecycle {
    active: Mutex<usize>,
    closed: std::sync::atomic::AtomicBool,
    changed: Condvar,
}

impl TaskLifecycle {
    pub(crate) fn is_idle(&self) -> bool {
        *self.active.lock().unwrap_or_else(|error| error.into_inner()) == 0
    }

    pub(crate) fn wait_idle(&self) {
        let mut active = self.active.lock().unwrap_or_else(|error| error.into_inner());
        while *active != 0 {
            active = self.changed.wait(active).unwrap_or_else(|error| error.into_inner());
        }
    }

    pub(crate) fn close_and_wait(&self) {
        {
            let _active = self.active.lock().unwrap_or_else(|error| error.into_inner());
            self.closed.store(true, std::sync::atomic::Ordering::Release);
        }
        self.wait_idle();
    }

    pub(crate) fn admit(self: &Arc<Self>) -> Option<TaskAdmission> {
        let mut active = self.active.lock().unwrap_or_else(|error| error.into_inner());
        if self.closed.load(std::sync::atomic::Ordering::Acquire) { return None; }
        *active += 1;
        Some(TaskAdmission { lifecycle: self.clone() })
    }
}

pub(crate) struct TaskAdmission {
    lifecycle: Arc<TaskLifecycle>,
}

impl Drop for TaskAdmission {
    fn drop(&mut self) {
        let mut active = self.lifecycle.active.lock().unwrap_or_else(|error| error.into_inner());
        *active -= 1;
        self.lifecycle.changed.notify_all();
    }
}

pub struct TrackedTask<T: Task> {
    inner: T,
    admission: Option<TaskAdmission>,
}

impl<T: Task> TrackedTask<T> {
    pub(crate) fn new(lifecycle: &Arc<TaskLifecycle>, inner: T) -> Self {
        Self { inner, admission: lifecycle.admit() }
    }
}

impl<T: Task> Task for TrackedTask<T> {
    type Output = T::Output;
    type JsValue = T::JsValue;

    fn compute(&mut self) -> Result<Self::Output> {
        // This local guard is dropped on success, error and unwinding.
        // Never wait for JS resolve/finally to release native admission.
        let _admission = self.admission.take().ok_or_else(||
            napi::Error::from_reason("KNOWLEDGE_STORE_CLOSED"))?;
        self.inner.compute()
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        self.inner.resolve(env, output)
    }

    fn reject(&mut self, env: Env, error: napi::Error) -> Result<Self::JsValue> {
        self.inner.reject(env, error)
    }

    fn finally(&mut self, env: Env) -> Result<()> {
        self.inner.finally(env)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EmptyTask;
    impl Task for EmptyTask {
        type Output = String;
        type JsValue = String;
        fn compute(&mut self) -> Result<String> { Ok(String::new()) }
        fn resolve(&mut self, _env: Env, output: String) -> Result<String> { Ok(output) }
    }

    #[test]
    fn computation_releases_admission_before_js_resolution() {
        let lifecycle = Arc::new(TaskLifecycle::default());
        let mut task = TrackedTask::new(&lifecycle, EmptyTask);
        assert_eq!(*lifecycle.active.lock().unwrap(), 1);
        task.compute().unwrap();
        lifecycle.wait_idle();
        assert_eq!(*lifecycle.active.lock().unwrap(), 0);
    }

    #[test]
    fn wait_idle_blocks_until_background_computation_finishes() {
        let lifecycle = Arc::new(TaskLifecycle::default());
        let task = TrackedTask::new(&lifecycle, EmptyTask);
        let (release, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut task = task;
            receive.recv().unwrap();
            task.compute().unwrap();
        });
        let waiting = lifecycle.clone();
        let (done, completed) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            waiting.wait_idle();
            done.send(()).unwrap();
        });
        assert!(completed.recv_timeout(std::time::Duration::from_millis(30)).is_err());
        release.send(()).unwrap();
        completed.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        worker.join().unwrap();
        waiter.join().unwrap();
    }

    #[test]
    fn panic_during_computation_releases_admission() {
        struct PanicTask;
        impl Task for PanicTask {
            type Output = String;
            type JsValue = String;
            fn compute(&mut self) -> Result<String> { panic!("injected compute panic") }
            fn resolve(&mut self, _env: Env, output: String) -> Result<String> { Ok(output) }
        }
        let lifecycle = Arc::new(TaskLifecycle::default());
        let mut task = TrackedTask::new(&lifecycle, PanicTask);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| task.compute()));
        assert!(result.is_err());
        lifecycle.wait_idle();
        assert_eq!(*lifecycle.active.lock().unwrap(), 0);
    }

    #[test]
    fn dropping_unstarted_task_releases_admission() {
        let lifecycle = Arc::new(TaskLifecycle::default());
        let task = TrackedTask::new(&lifecycle, EmptyTask);
        drop(task);
        lifecycle.wait_idle();
        assert_eq!(*lifecycle.active.lock().unwrap(), 0);
    }
}