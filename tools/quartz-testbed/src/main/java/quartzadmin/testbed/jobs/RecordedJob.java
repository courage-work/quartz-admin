package quartzadmin.testbed.jobs;

import org.quartz.InterruptableJob;
import org.quartz.Job;
import org.quartz.JobExecutionContext;
import org.quartz.JobExecutionException;
import org.quartz.SchedulerException;
import quartzadmin.testbed.ExecutionRecorder;

/** 테스트 잡의 공통 부분. 시작과 종료를 {@link ExecutionRecorder}에 남긴다. */
public abstract class RecordedJob implements Job, InterruptableJob {

  private volatile boolean interrupted;

  @Override
  public final void execute(JobExecutionContext ctx) throws JobExecutionException {
    ExecutionRecorder recorder = recorder(ctx);
    recorder.recordStart(ctx);
    String outcome = "OK";
    try {
      run(ctx);
      if (interrupted) {
        outcome = "INTERRUPTED";
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      outcome = "INTERRUPTED";
    } catch (RuntimeException e) {
      outcome = "ERROR";
      throw new JobExecutionException(e);
    } finally {
      recorder.recordFinish(ctx, outcome);
    }
  }

  /** 잡 본문. 오래 걸리는 잡은 {@link #sleep(long)}으로 기다려야 interrupt에 반응한다. */
  protected abstract void run(JobExecutionContext ctx) throws InterruptedException;

  @Override
  public void interrupt() {
    interrupted = true;
    synchronized (this) {
      notifyAll();
    }
  }

  /** interrupt되면 일찍 깬다. */
  protected final void sleep(long millis) throws InterruptedException {
    long until = System.currentTimeMillis() + millis;
    synchronized (this) {
      while (!interrupted) {
        long left = until - System.currentTimeMillis();
        if (left <= 0) {
          return;
        }
        wait(left);
      }
    }
  }

  protected static long longData(JobExecutionContext ctx, String key, long fallback) {
    Object v = ctx.getMergedJobDataMap().get(key);
    if (v instanceof Number n) {
      return n.longValue();
    }
    if (v instanceof String s && !s.isBlank()) {
      return Long.parseLong(s.trim());
    }
    return fallback;
  }

  private static ExecutionRecorder recorder(JobExecutionContext ctx) throws JobExecutionException {
    try {
      Object r = ctx.getScheduler().getContext().get(ExecutionRecorder.CONTEXT_KEY);
      if (r instanceof ExecutionRecorder recorder) {
        return recorder;
      }
      throw new JobExecutionException("SchedulerContext에 실행 기록기가 없습니다");
    } catch (SchedulerException e) {
      throw new JobExecutionException(e);
    }
  }
}
