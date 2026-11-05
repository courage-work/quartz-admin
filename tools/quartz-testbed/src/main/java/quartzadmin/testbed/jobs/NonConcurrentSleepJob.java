package quartzadmin.testbed.jobs;

import org.quartz.DisallowConcurrentExecution;
import org.quartz.JobExecutionContext;

/**
 * 같은 JobDetail이 동시에 실행되지 않는 잡. JobDataMap의 {@code sleepSeconds}(기본 5)초 동안 실행된다.
 *
 * <p>실행 중에는 같은 잡의 다른 트리거가 BLOCKED 상태가 된다.
 */
@DisallowConcurrentExecution
public class NonConcurrentSleepJob extends RecordedJob {

  public static final long DEFAULT_SLEEP_SECONDS = 5;

  @Override
  protected void run(JobExecutionContext ctx) throws InterruptedException {
    sleep(longData(ctx, "sleepSeconds", DEFAULT_SLEEP_SECONDS) * 1000);
  }
}
