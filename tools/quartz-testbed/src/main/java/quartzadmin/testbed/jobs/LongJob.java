package quartzadmin.testbed.jobs;

import org.quartz.JobExecutionContext;

/**
 * 오래 실행되는 잡. JobDataMap의 {@code durationSeconds}(기본 600)초 동안 실행되며, {@code /control/interrupt}로 멈출 수
 * 있다. 실행 중 상태(FIRED_TRIGGERS의 EXECUTING 행)를 만들 때 쓴다.
 */
public class LongJob extends RecordedJob {

  public static final long DEFAULT_DURATION_SECONDS = 600;

  @Override
  protected void run(JobExecutionContext ctx) throws InterruptedException {
    sleep(longData(ctx, "durationSeconds", DEFAULT_DURATION_SECONDS) * 1000);
  }
}
