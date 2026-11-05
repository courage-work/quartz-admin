package quartzadmin.testbed.jobs;

import org.quartz.JobExecutionContext;

/** 실행 기록만 남기고 바로 끝나는 잡. */
public class RecordingJob extends RecordedJob {

  @Override
  protected void run(JobExecutionContext ctx) {
    // 기록은 RecordedJob이 남긴다
  }
}
