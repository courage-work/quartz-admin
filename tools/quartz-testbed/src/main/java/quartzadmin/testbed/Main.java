package quartzadmin.testbed;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import org.quartz.Scheduler;
import org.quartz.core.QuartzScheduler;
import org.quartz.impl.StdSchedulerFactory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import quartzadmin.testbed.http.ControlServer;

/**
 * quartz-testbed 진입점.
 *
 * <pre>
 * server                                   클러스터 노드로 기동(기본값)
 * cron-vectors [--input F] [--output F]   cron 다음 실행 시각 벡터 생성(기본 stdin → stdout)
 * core-vectors [--input F] [--output F]   @qa/core 이식 검증 벡터 생성(cron, 트리거, 타임존, properties)
 * version                                  Quartz 버전 출력
 * </pre>
 */
public final class Main {

  private static final Logger log = LoggerFactory.getLogger(Main.class);

  private Main() {}

  public static void main(String[] args) throws Exception {
    String command = args.length == 0 ? "server" : args[0];
    switch (command) {
      case "server" -> server();
      case "cron-vectors" -> vectors(args, CronVectors::generate);
      case "core-vectors" -> vectors(args, CoreVectors::generate);
      case "version" -> System.out.println(quartzVersion());
      default -> {
        System.err.println("알 수 없는 명령입니다: " + command + " (server | cron-vectors | core-vectors | version)");
        System.exit(2);
      }
    }
  }

  static String quartzVersion() {
    return QuartzScheduler.getVersionMajor()
        + "."
        + QuartzScheduler.getVersionMinor()
        + "."
        + QuartzScheduler.getVersionIteration();
  }

  private static void server() throws Exception {
    TestbedConfig cfg = TestbedConfig.fromEnv(System.getenv());
    StdSchedulerFactory factory = new StdSchedulerFactory(cfg.toQuartzProperties());
    Scheduler scheduler = factory.getScheduler();
    String instanceId = scheduler.getSchedulerInstanceId();

    ExecutionRecorder recorder = ExecutionRecorder.create(cfg, instanceId);
    scheduler.getContext().put(ExecutionRecorder.CONTEXT_KEY, recorder);

    ControlServer http = new ControlServer(scheduler, cfg.httpPort);
    CountDownLatch stopped = new CountDownLatch(1);
    Runtime.getRuntime()
        .addShutdownHook(
            new Thread(
                () -> {
                  log.info("종료합니다");
                  http.close();
                  try {
                    // 테스트에서는 빨리 내려가는 편이 낫다. 실행 중인 잡은 기다리지 않는다
                    scheduler.shutdown(false);
                  } catch (Exception e) {
                    log.warn("스케줄러 종료 실패", e);
                  }
                  recorder.close();
                  stopped.countDown();
                },
                "testbed-shutdown"));

    scheduler.start();
    http.start();
    log.info(
        "Quartz {} 노드 기동: scheduler={}, instanceId={}, tablePrefix={}",
        quartzVersion(),
        cfg.schedulerName,
        instanceId,
        cfg.tablePrefix);
    stopped.await();
  }

  private static void vectors(String[] args, java.util.function.Function<JsonNode, JsonNode> generator)
      throws Exception {
    Path input = null;
    Path output = null;
    for (int i = 1; i < args.length; i++) {
      switch (args[i]) {
        case "--input" -> input = Path.of(args[++i]);
        case "--output" -> output = Path.of(args[++i]);
        default -> throw new IllegalArgumentException("알 수 없는 옵션입니다: " + args[i]);
      }
    }
    ObjectMapper json = new ObjectMapper();
    JsonNode in;
    try (InputStream s = input == null ? System.in : Files.newInputStream(input)) {
      in = json.readTree(s);
    }
    JsonNode result = generator.apply(in);
    byte[] bytes =
        (json.writerWithDefaultPrettyPrinter().writeValueAsString(result) + "\n")
            .getBytes(java.nio.charset.StandardCharsets.UTF_8);
    if (output == null) {
      System.out.write(bytes);
      System.out.flush();
    } else {
      try (OutputStream s = Files.newOutputStream(output)) {
        s.write(bytes);
      }
    }
  }
}
