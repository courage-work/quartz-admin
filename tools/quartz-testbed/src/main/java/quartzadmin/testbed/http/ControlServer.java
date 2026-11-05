package quartzadmin.testbed.http;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import org.quartz.CronTrigger;
import org.quartz.DisallowConcurrentExecution;
import org.quartz.JobDetail;
import org.quartz.JobExecutionContext;
import org.quartz.JobKey;
import org.quartz.ObjectAlreadyExistsException;
import org.quartz.PersistJobDataAfterExecution;
import org.quartz.Scheduler;
import org.quartz.SchedulerException;
import org.quartz.SchedulerMetaData;
import org.quartz.SimpleTrigger;
import org.quartz.Trigger;
import org.quartz.TriggerKey;
import org.quartz.utils.ClassUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import quartzadmin.testbed.Specs;
import quartzadmin.testbed.Specs.BadRequest;

/**
 * Quartz {@link Scheduler} 메서드를 그대로 호출하는 HTTP API. 차등 테스트에서 "Quartz가 직접 했을 때"의 결과를 만드는 데 쓴다.
 *
 * <p>쓰기는 {@code POST /control/<메서드 이름>}에 JSON 본문, 읽기는 {@code GET}에 쿼리 파라미터를 쓴다. 성공하면 {@code
 * {"result": ...}}, 실패하면 {@code {"error": "...", "message": "..."}}를 돌려준다.
 */
public final class ControlServer implements AutoCloseable {

  private static final Logger log = LoggerFactory.getLogger(ControlServer.class);
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final JsonNodeFactory F = JsonNodeFactory.instance;

  @FunctionalInterface
  interface Handler {
    Object handle(JsonNode body, Map<String, String> query) throws Exception;
  }

  private final Scheduler scheduler;
  private final HttpServer server;
  private final Map<String, Handler> posts = new LinkedHashMap<>();
  private final Map<String, Handler> gets = new LinkedHashMap<>();

  public ControlServer(Scheduler scheduler, int port) throws IOException {
    this.scheduler = scheduler;
    this.server = HttpServer.create(new InetSocketAddress(port), 0);
    this.server.setExecutor(Executors.newFixedThreadPool(4));
    registerRoutes();
    this.server.createContext("/", this::dispatch);
  }

  public void start() {
    server.start();
    log.info("제어 API가 :{}에서 대기합니다", server.getAddress().getPort());
  }

  @Override
  public void close() {
    server.stop(0);
  }

  private void registerRoutes() {
    gets.put("/healthz", (b, q) -> health());
    gets.put("/control/metadata", (b, q) -> metadata());
    gets.put("/control/triggerState", (b, q) -> scheduler.getTriggerState(triggerKey(q)).name());
    gets.put("/control/trigger", (b, q) -> triggerJson(scheduler.getTrigger(triggerKey(q))));
    gets.put("/control/job", (b, q) -> jobJson(scheduler.getJobDetail(jobKey(q))));
    gets.put("/control/pausedTriggerGroups", (b, q) -> scheduler.getPausedTriggerGroups());
    gets.put("/control/currentlyExecutingJobs", (b, q) -> executing());

    posts.put("/control/scheduleJob", (b, q) -> scheduleJob(b));
    posts.put(
        "/control/addJob",
        (b, q) -> {
          scheduler.addJob(Specs.job(b.get("job")), b.path("replace").asBoolean(false));
          return null;
        });
    posts.put("/control/pauseTrigger", (b, q) -> run(() -> scheduler.pauseTrigger(Specs.triggerKey(b))));
    posts.put("/control/resumeTrigger", (b, q) -> run(() -> scheduler.resumeTrigger(Specs.triggerKey(b))));
    posts.put("/control/pauseJob", (b, q) -> run(() -> scheduler.pauseJob(Specs.jobKey(b))));
    posts.put("/control/resumeJob", (b, q) -> run(() -> scheduler.resumeJob(Specs.jobKey(b))));
    posts.put(
        "/control/pauseTriggers",
        (b, q) -> run(() -> scheduler.pauseTriggers(Specs.<TriggerKey>groupMatcher(b))));
    posts.put(
        "/control/resumeTriggers",
        (b, q) -> run(() -> scheduler.resumeTriggers(Specs.<TriggerKey>groupMatcher(b))));
    posts.put(
        "/control/pauseJobs", (b, q) -> run(() -> scheduler.pauseJobs(Specs.<JobKey>groupMatcher(b))));
    posts.put(
        "/control/resumeJobs",
        (b, q) -> run(() -> scheduler.resumeJobs(Specs.<JobKey>groupMatcher(b))));
    posts.put("/control/pauseAll", (b, q) -> run(scheduler::pauseAll));
    posts.put("/control/resumeAll", (b, q) -> run(scheduler::resumeAll));
    posts.put("/control/triggerJob", (b, q) -> triggerJob(b));
    posts.put("/control/rescheduleJob", (b, q) -> rescheduleJob(b));
    posts.put("/control/unscheduleJob", (b, q) -> scheduler.unscheduleJob(Specs.triggerKey(b)));
    posts.put("/control/deleteJob", (b, q) -> scheduler.deleteJob(Specs.jobKey(b)));
    posts.put("/control/interrupt", (b, q) -> scheduler.interrupt(Specs.jobKey(b)));
  }

  // ---- 핸들러 ----

  private Object health() throws SchedulerException {
    ObjectNode n = F.objectNode();
    n.put("status", scheduler.isStarted() && !scheduler.isShutdown() ? "ok" : "starting");
    return n;
  }

  private Object metadata() throws SchedulerException {
    SchedulerMetaData md = scheduler.getMetaData();
    ObjectNode n = F.objectNode();
    n.put("schedulerName", md.getSchedulerName());
    n.put("instanceId", md.getSchedulerInstanceId());
    n.put("quartzVersion", md.getVersion());
    n.put("started", md.isStarted());
    n.put("standby", md.isInStandbyMode());
    n.put("shutdown", md.isShutdown());
    n.put("clustered", md.isJobStoreClustered());
    n.put("jobStore", md.getJobStoreClass().getName());
    n.put("threadPoolSize", md.getThreadPoolSize());
    n.put("numberOfJobsExecuted", md.getNumberOfJobsExecuted());
    return n;
  }

  /** {@code {"job": 잡 명세, "trigger": 트리거 명세}}. job 없이 trigger에 forJob을 주면 기존 잡에 트리거를 붙인다. */
  private Object scheduleJob(JsonNode b) throws SchedulerException {
    Trigger trigger = Specs.trigger(b.get("trigger"));
    Date first;
    if (b.hasNonNull("job")) {
      JobDetail job = Specs.job(b.get("job"));
      if (b.path("replace").asBoolean(false)) {
        scheduler.scheduleJob(job, java.util.Set.of(trigger), true);
        first = scheduler.getTrigger(trigger.getKey()).getNextFireTime();
      } else {
        first = scheduler.scheduleJob(job, trigger);
      }
    } else {
      if (trigger.getJobKey() == null) {
        throw new BadRequest("job이 없으면 trigger.forJob이 필요합니다");
      }
      first = scheduler.scheduleJob(trigger);
    }
    return time(first);
  }

  /** {@code {"name","group","data"}}. Quartz가 DEFAULT 그룹에 MT_ 접두어의 1회용 트리거를 만든다. */
  private Object triggerJob(JsonNode b) throws SchedulerException {
    JobKey key = Specs.jobKey(b);
    if (b.hasNonNull("data")) {
      scheduler.triggerJob(key, Specs.dataMap(b.get("data")));
    } else {
      scheduler.triggerJob(key);
    }
    return null;
  }

  /** {@code {"name","group","trigger": 새 트리거 명세}}. 결과는 새 트리거의 첫 실행 시각, 기존 트리거가 없으면 null. */
  private Object rescheduleJob(JsonNode b) throws SchedulerException {
    return time(scheduler.rescheduleJob(Specs.triggerKey(b), Specs.trigger(b.get("trigger"))));
  }

  private Object executing() throws SchedulerException {
    ArrayNode arr = F.arrayNode();
    for (JobExecutionContext ctx : scheduler.getCurrentlyExecutingJobs()) {
      ObjectNode n = arr.addObject();
      n.put("fireInstanceId", ctx.getFireInstanceId());
      n.put("jobName", ctx.getJobDetail().getKey().getName());
      n.put("jobGroup", ctx.getJobDetail().getKey().getGroup());
      n.put("triggerName", ctx.getTrigger().getKey().getName());
      n.put("triggerGroup", ctx.getTrigger().getKey().getGroup());
      n.put("fireTime", ctx.getFireTime().getTime());
    }
    return arr;
  }

  private static Object triggerJson(Trigger t) {
    if (t == null) {
      return null;
    }
    ObjectNode n = F.objectNode();
    n.put("name", t.getKey().getName());
    n.put("group", t.getKey().getGroup());
    n.put("jobName", t.getJobKey().getName());
    n.put("jobGroup", t.getJobKey().getGroup());
    n.put("description", t.getDescription());
    n.put("priority", t.getPriority());
    n.put("misfireInstruction", t.getMisfireInstruction());
    n.put("calendarName", t.getCalendarName());
    n.set("startTime", time(t.getStartTime()));
    n.set("endTime", time(t.getEndTime()));
    n.set("nextFireTime", time(t.getNextFireTime()));
    n.set("previousFireTime", time(t.getPreviousFireTime()));
    n.set("data", JSON.valueToTree(plain(t.getJobDataMap())));
    if (t instanceof CronTrigger c) {
      n.put("type", "cron");
      n.put("cron", c.getCronExpression());
      n.put("timeZone", c.getTimeZone().getID());
    } else if (t instanceof SimpleTrigger s) {
      n.put("type", "simple");
      n.put("repeatCount", s.getRepeatCount());
      n.put("intervalMs", s.getRepeatInterval());
      n.put("timesTriggered", s.getTimesTriggered());
    } else {
      n.put("type", t.getClass().getSimpleName());
    }
    return n;
  }

  private static Object jobJson(JobDetail j) {
    if (j == null) {
      return null;
    }
    ObjectNode n = F.objectNode();
    n.put("name", j.getKey().getName());
    n.put("group", j.getKey().getGroup());
    n.put("jobClass", j.getJobClass().getName());
    n.put("description", j.getDescription());
    n.put("durable", j.isDurable());
    n.put("requestsRecovery", j.requestsRecovery());
    // 2.3.2의 isConcurrentExectionDisallowed는 2.5에서 이름이 바뀌어 두 버전에 공통인 애너테이션으로 본다
    n.put(
        "concurrentExecutionDisallowed",
        ClassUtils.isAnnotationPresent(j.getJobClass(), DisallowConcurrentExecution.class));
    n.put(
        "persistJobDataAfterExecution",
        ClassUtils.isAnnotationPresent(j.getJobClass(), PersistJobDataAfterExecution.class));
    n.set("data", JSON.valueToTree(plain(j.getJobDataMap())));
    return n;
  }

  private static Map<String, Object> plain(Map<String, Object> map) {
    Map<String, Object> out = new HashMap<>();
    map.forEach(
        (k, v) ->
            out.put(
                k,
                v instanceof String || v instanceof Number || v instanceof Boolean || v == null
                    ? v
                    : String.valueOf(v)));
    return out;
  }

  private static JsonNode time(Date d) {
    return d == null ? NullNode.getInstance() : F.numberNode(d.getTime());
  }

  // ---- HTTP 처리 ----

  @FunctionalInterface
  private interface Action {
    void run() throws SchedulerException;
  }

  private static Object run(Action action) throws SchedulerException {
    action.run();
    return null;
  }

  private static TriggerKey triggerKey(Map<String, String> q) {
    return Specs.triggerKey(JSON.valueToTree(q));
  }

  private static JobKey jobKey(Map<String, String> q) {
    return Specs.jobKey(JSON.valueToTree(q));
  }

  private void dispatch(HttpExchange ex) throws IOException {
    String method = ex.getRequestMethod();
    String path = ex.getRequestURI().getPath();
    try {
      Handler h =
          switch (method) {
            case "GET" -> gets.get(path);
            case "POST" -> posts.get(path);
            default -> null;
          };
      if (h == null) {
        boolean known = gets.containsKey(path) || posts.containsKey(path);
        send(ex, known ? 405 : 404, error(known ? "METHOD_NOT_ALLOWED" : "NOT_FOUND", method + " " + path));
        return;
      }
      JsonNode body = "POST".equals(method) ? readBody(ex) : F.objectNode();
      Map<String, String> query = query(ex.getRequestURI().getRawQuery());
      Object result = h.handle(body, query);
      if ("POST".equals(method)) {
        log.info("{} {}", path, body);
      }
      if (path.equals("/healthz")) {
        boolean ok = "ok".equals(((ObjectNode) result).get("status").asText());
        send(ex, ok ? 200 : 503, result);
        return;
      }
      ObjectNode out = F.objectNode();
      out.set("result", result == null ? NullNode.getInstance() : JSON.valueToTree(result));
      send(ex, 200, out);
    } catch (BadRequest | IllegalArgumentException e) {
      send(ex, 400, error("BAD_REQUEST", e.getMessage()));
    } catch (ObjectAlreadyExistsException e) {
      send(ex, 409, error("ALREADY_EXISTS", e.getMessage()));
    } catch (Exception e) {
      log.warn("{} {} 실패", method, path, e);
      send(ex, 500, error(e.getClass().getSimpleName(), String.valueOf(e.getMessage())));
    }
  }

  private static JsonNode readBody(HttpExchange ex) throws IOException {
    try (InputStream in = ex.getRequestBody()) {
      byte[] bytes = in.readAllBytes();
      if (bytes.length == 0) {
        return F.objectNode();
      }
      try {
        return JSON.readTree(bytes);
      } catch (IOException e) {
        throw new BadRequest("JSON 본문을 읽지 못했습니다: " + e.getMessage());
      }
    }
  }

  static Map<String, String> query(String raw) {
    Map<String, String> q = new LinkedHashMap<>();
    if (raw == null || raw.isEmpty()) {
      return q;
    }
    for (String part : raw.split("&")) {
      int eq = part.indexOf('=');
      String k = eq < 0 ? part : part.substring(0, eq);
      String v = eq < 0 ? "" : part.substring(eq + 1);
      q.put(
          URLDecoder.decode(k, StandardCharsets.UTF_8), URLDecoder.decode(v, StandardCharsets.UTF_8));
    }
    return q;
  }

  private static ObjectNode error(String code, String message) {
    ObjectNode n = F.objectNode();
    n.put("error", code);
    n.put("message", message);
    return n;
  }

  private static void send(HttpExchange ex, int status, Object body) throws IOException {
    byte[] bytes = JSON.writeValueAsBytes(body);
    ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    ex.sendResponseHeaders(status, bytes.length);
    try (OutputStream out = ex.getResponseBody()) {
      out.write(bytes);
    }
  }
}
