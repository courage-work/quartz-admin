package quartzadmin.testbed;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Date;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import org.quartz.CronScheduleBuilder;
import org.quartz.Job;
import org.quartz.JobBuilder;
import org.quartz.JobDataMap;
import org.quartz.JobDetail;
import org.quartz.JobKey;
import org.quartz.ScheduleBuilder;
import org.quartz.SimpleScheduleBuilder;
import org.quartz.Trigger;
import org.quartz.TriggerBuilder;
import org.quartz.TriggerKey;
import org.quartz.impl.matchers.GroupMatcher;
import org.quartz.utils.Key;
import quartzadmin.testbed.jobs.LongJob;
import quartzadmin.testbed.jobs.NonConcurrentSleepJob;
import quartzadmin.testbed.jobs.RecordingJob;

/** HTTP 요청 JSON을 Quartz 객체로 바꾼다. 잘못된 입력은 {@link BadRequest}로 알린다. */
public final class Specs {

  private Specs() {}

  /** 400으로 응답할 입력 오류. */
  public static final class BadRequest extends RuntimeException {
    public BadRequest(String message) {
      super(message);
    }
  }

  static final Map<String, Class<? extends Job>> JOB_TYPES =
      Map.of(
          "RecordingJob", RecordingJob.class,
          "NonConcurrentSleepJob", NonConcurrentSleepJob.class,
          "LongJob", LongJob.class);

  public static JobKey jobKey(JsonNode node) {
    return new JobKey(requiredText(node, "name"), group(node));
  }

  public static TriggerKey triggerKey(JsonNode node) {
    return new TriggerKey(requiredText(node, "name"), group(node));
  }

  private static String group(JsonNode node) {
    JsonNode g = node.get("group");
    return g == null || g.isNull() ? Key.DEFAULT_GROUP : g.asText();
  }

  /**
   * {@code {"name","group","type","description","durable","requestsRecovery","data"}}. type은 RecordingJob,
   * NonConcurrentSleepJob, LongJob 중 하나.
   */
  public static JobDetail job(JsonNode node) {
    if (node == null || !node.isObject()) {
      throw new BadRequest("job 객체가 필요합니다");
    }
    String type = requiredText(node, "type");
    Class<? extends Job> jobClass = JOB_TYPES.get(type);
    if (jobClass == null) {
      throw new BadRequest("알 수 없는 잡 종류입니다: " + type + " (가능: " + JOB_TYPES.keySet() + ")");
    }
    JobBuilder b =
        JobBuilder.newJob(jobClass)
            .withIdentity(jobKey(node))
            .storeDurably(node.path("durable").asBoolean(false))
            .requestRecovery(node.path("requestsRecovery").asBoolean(false));
    if (node.hasNonNull("description")) {
      b.withDescription(node.get("description").asText());
    }
    JobDataMap data = dataMap(node.get("data"));
    if (!data.isEmpty()) {
      b.usingJobData(data);
    }
    return b.build();
  }

  /**
   * 트리거 명세.
   *
   * <pre>
   * {"name","group","description","priority","startAt"(epoch ms, 기본 지금),"endAt","forJob":{"name","group"},
   *  "data":{...},"misfire":"FIRE_NOW"|..,
   *  "type":"simple","intervalMs":1000,"repeatCount":-1
   *  | "type":"cron","cron":"0/5 * * * * ?","timeZone":"Asia/Seoul"}
   * </pre>
   */
  public static Trigger trigger(JsonNode node) {
    if (node == null || !node.isObject()) {
      throw new BadRequest("trigger 객체가 필요합니다");
    }
    String type = node.path("type").asText("simple").toLowerCase(Locale.ROOT);
    TriggerBuilder<Trigger> b = TriggerBuilder.newTrigger().withIdentity(triggerKey(node));
    if (node.hasNonNull("description")) {
      b.withDescription(node.get("description").asText());
    }
    if (node.hasNonNull("priority")) {
      b.withPriority(node.get("priority").asInt());
    }
    if (node.hasNonNull("startAt")) {
      b.startAt(new Date(node.get("startAt").asLong()));
    } else {
      b.startNow();
    }
    if (node.hasNonNull("endAt")) {
      b.endAt(new Date(node.get("endAt").asLong()));
    }
    if (node.hasNonNull("forJob")) {
      b.forJob(jobKey(node.get("forJob")));
    }
    JobDataMap data = dataMap(node.get("data"));
    if (!data.isEmpty()) {
      b.usingJobData(data);
    }
    String misfire = node.hasNonNull("misfire") ? node.get("misfire").asText() : null;
    ScheduleBuilder<?> schedule =
        switch (type) {
          case "simple" -> simpleSchedule(node, misfire);
          case "cron" -> cronSchedule(node, misfire);
          default -> throw new BadRequest("알 수 없는 트리거 종류입니다: " + type + " (가능: simple, cron)");
        };
    return b.withSchedule(schedule).build();
  }

  private static SimpleScheduleBuilder simpleSchedule(JsonNode node, String misfire) {
    long intervalMs = node.path("intervalMs").asLong(0);
    int repeatCount = node.path("repeatCount").asInt(intervalMs > 0 ? -1 : 0);
    SimpleScheduleBuilder s =
        SimpleScheduleBuilder.simpleSchedule().withRepeatCount(repeatCount);
    if (intervalMs > 0) {
      s.withIntervalInMilliseconds(intervalMs);
    } else if (repeatCount != 0) {
      throw new BadRequest("repeatCount가 0이 아니면 intervalMs가 필요합니다");
    }
    if (misfire == null) {
      return s;
    }
    return switch (normalizeMisfire(misfire)) {
      case "SMART_POLICY" -> s;
      case "IGNORE_MISFIRE_POLICY" -> s.withMisfireHandlingInstructionIgnoreMisfires();
      case "FIRE_NOW" -> s.withMisfireHandlingInstructionFireNow();
      case "RESCHEDULE_NOW_WITH_EXISTING_REPEAT_COUNT" ->
          s.withMisfireHandlingInstructionNowWithExistingCount();
      case "RESCHEDULE_NOW_WITH_REMAINING_REPEAT_COUNT" ->
          s.withMisfireHandlingInstructionNowWithRemainingCount();
      case "RESCHEDULE_NEXT_WITH_REMAINING_COUNT" ->
          s.withMisfireHandlingInstructionNextWithRemainingCount();
      case "RESCHEDULE_NEXT_WITH_EXISTING_COUNT" ->
          s.withMisfireHandlingInstructionNextWithExistingCount();
      default -> throw new BadRequest("SIMPLE 트리거에 쓸 수 없는 misfire 처리 방식입니다: " + misfire);
    };
  }

  private static CronScheduleBuilder cronSchedule(JsonNode node, String misfire) {
    String cron = requiredText(node, "cron");
    CronScheduleBuilder s;
    try {
      s = CronScheduleBuilder.cronScheduleNonvalidatedExpression(cron);
    } catch (java.text.ParseException e) {
      throw new BadRequest("cron 표현식이 올바르지 않습니다: " + e.getMessage());
    }
    if (node.hasNonNull("timeZone")) {
      s.inTimeZone(TimeZone.getTimeZone(node.get("timeZone").asText()));
    }
    if (misfire == null) {
      return s;
    }
    return switch (normalizeMisfire(misfire)) {
      case "SMART_POLICY" -> s;
      case "IGNORE_MISFIRE_POLICY" -> s.withMisfireHandlingInstructionIgnoreMisfires();
      case "FIRE_ONCE_NOW" -> s.withMisfireHandlingInstructionFireAndProceed();
      case "DO_NOTHING" -> s.withMisfireHandlingInstructionDoNothing();
      default -> throw new BadRequest("CRON 트리거에 쓸 수 없는 misfire 처리 방식입니다: " + misfire);
    };
  }

  /** {@code MISFIRE_INSTRUCTION_FIRE_NOW}와 {@code FIRE_NOW}를 같은 값으로 본다. */
  static String normalizeMisfire(String value) {
    String v = value.trim().toUpperCase(Locale.ROOT);
    return v.startsWith("MISFIRE_INSTRUCTION_") ? v.substring("MISFIRE_INSTRUCTION_".length()) : v;
  }

  /** {@code {"group":"G","operator":"EQUALS"}}. operator는 EQUALS, STARTS_WITH, ENDS_WITH, CONTAINS, ANYTHING. */
  public static <T extends Key<T>> GroupMatcher<T> groupMatcher(JsonNode node) {
    String op = node.path("operator").asText("EQUALS").toUpperCase(Locale.ROOT);
    if (op.equals("ANYTHING")) {
      return GroupMatcher.anyGroup();
    }
    String group = requiredText(node, "group");
    return switch (op) {
      case "EQUALS" -> GroupMatcher.groupEquals(group);
      case "STARTS_WITH" -> GroupMatcher.groupStartsWith(group);
      case "ENDS_WITH" -> GroupMatcher.groupEndsWith(group);
      case "CONTAINS" -> GroupMatcher.groupContains(group);
      default -> throw new BadRequest("알 수 없는 operator입니다: " + op);
    };
  }

  /** JSON 객체의 문자열, 숫자, 불리언 값을 JobDataMap으로 옮긴다. 정수는 Long으로 넣는다. */
  public static JobDataMap dataMap(JsonNode node) {
    JobDataMap map = new JobDataMap();
    if (node == null || node.isNull()) {
      return map;
    }
    if (!node.isObject()) {
      throw new BadRequest("data는 객체여야 합니다");
    }
    for (Map.Entry<String, JsonNode> e : node.properties()) {
      JsonNode v = e.getValue();
      if (v.isTextual()) {
        map.put(e.getKey(), v.asText());
      } else if (v.isIntegralNumber()) {
        map.put(e.getKey(), v.asLong());
      } else if (v.isNumber()) {
        map.put(e.getKey(), v.asDouble());
      } else if (v.isBoolean()) {
        map.put(e.getKey(), v.asBoolean());
      } else {
        throw new BadRequest("data 값은 문자열, 숫자, 불리언만 됩니다: " + e.getKey());
      }
    }
    return map;
  }

  static String requiredText(JsonNode node, String field) {
    JsonNode v = node == null ? null : node.get(field);
    if (v == null || v.isNull() || v.asText().isEmpty()) {
      throw new BadRequest(field + " 값이 필요합니다");
    }
    return v.asText();
  }
}
