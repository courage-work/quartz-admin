package quartzadmin.testbed;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.text.ParseException;
import java.util.Date;
import java.util.Properties;
import java.util.TimeZone;
import java.util.TreeSet;
import org.quartz.impl.triggers.CronTriggerImpl;
import org.quartz.impl.triggers.SimpleTriggerImpl;

/**
 * {@code core-vectors} 서브커맨드. {@code @qa/core} 이식본(TRD §6)의 기준값을 실제 Quartz와 JDK로 만든다.
 *
 * <p>입력은 절마다 선택이다.
 *
 * <pre>
 * {"cron": {...cron-vectors 입력과 같음...},
 *  "cronTriggers": [{"id":"a","cron":"0 0 12 * * ?","timeZone":"Asia/Seoul",
 *                    "startTime":"2026-01-01T00:00:00Z","endTime":null,"count":5,"after":[...]}],
 *  "simpleTriggers": [{"id":"b","startTime":...,"endTime":null,"repeatCount":3,"repeatInterval":60000,
 *                      "timesTriggered":0,"count":5,"after":[...]}],
 *  "timeZones": [{"id":"EST","at":["2026-07-01T00:00:00Z"]}],
 *  "allTimeZonesAt": ["2026-01-15T00:00:00Z"],
 *  "properties": [{"id":"c","text":"a=1\nb:2"}]}
 * </pre>
 *
 * <p>트리거는 {@code computeFirstFireTime(null)}로 첫 시각을, 이어서 {@code getFireTimeAfter(직전 시각)}로 {@code count}개까지
 * 시각을 만든다. {@code after}의 각 시각에 대해서는 {@code getFireTimeAfter(after)} 한 번의 결과를 남긴다. 트리거를 만들 수 없으면
 * {@code error}에 예외 메시지를 담는다.
 */
public final class CoreVectors {

  private static final JsonNodeFactory F = JsonNodeFactory.instance;

  private CoreVectors() {}

  public static ObjectNode generate(JsonNode input) {
    ObjectNode out = F.objectNode();
    out.put("quartzVersion", Main.quartzVersion());
    out.put("javaVersion", System.getProperty("java.version"));
    if (input.has("cron")) {
      out.set("cron", CronVectors.generate(input.get("cron")).get("results"));
    }
    if (input.has("cronTriggers")) {
      ArrayNode results = out.putArray("cronTriggers");
      for (JsonNode c : input.get("cronTriggers")) {
        results.add(cronTrigger(c));
      }
    }
    if (input.has("simpleTriggers")) {
      ArrayNode results = out.putArray("simpleTriggers");
      for (JsonNode c : input.get("simpleTriggers")) {
        results.add(simpleTrigger(c));
      }
    }
    if (input.has("timeZones")) {
      ArrayNode results = out.putArray("timeZones");
      for (JsonNode c : input.get("timeZones")) {
        results.add(timeZone(c));
      }
    }
    if (input.has("allTimeZonesAt")) {
      // JDK가 아는 모든 ID와 시점별 오프셋. 이식본의 ID 판정과 오프셋 계산을 함께 검증한다
      ArrayNode results = out.putArray("allTimeZones");
      for (String id : TimeZone.getAvailableIDs()) {
        ObjectNode c = F.objectNode();
        c.put("id", id);
        c.set("at", input.get("allTimeZonesAt"));
        results.add(timeZone(c));
      }
    }
    if (input.has("properties")) {
      ArrayNode results = out.putArray("properties");
      for (JsonNode c : input.get("properties")) {
        results.add(properties(c));
      }
    }
    return out;
  }

  static ObjectNode cronTrigger(JsonNode c) {
    ObjectNode r = echo(c);
    CronTriggerImpl t = new CronTriggerImpl();
    try {
      t.setCronExpression(c.path("cron").asText());
      t.setTimeZone(TimeZone.getTimeZone(c.path("timeZone").asText("UTC")));
      t.setStartTime(new Date(time(c.get("startTime"))));
      if (c.hasNonNull("endTime")) {
        t.setEndTime(new Date(time(c.get("endTime"))));
      }
    } catch (ParseException | IllegalArgumentException e) {
      r.put("error", e.getMessage());
      return r;
    }
    r.put("normalizedStartTime", t.getStartTime().getTime());
    try {
      sequence(r, t.computeFirstFireTime(null), c.path("count").asInt(5), t::getFireTimeAfter);
      afters(r, c, t::getFireTimeAfter);
    } catch (RuntimeException e) {
      r.remove("fireTimes");
      r.remove("afterResults");
      r.put("runtimeError", e.getClass().getSimpleName());
    }
    return r;
  }

  static ObjectNode simpleTrigger(JsonNode c) {
    ObjectNode r = echo(c);
    SimpleTriggerImpl t = new SimpleTriggerImpl();
    try {
      t.setStartTime(new Date(time(c.get("startTime"))));
      if (c.hasNonNull("endTime")) {
        t.setEndTime(new Date(time(c.get("endTime"))));
      }
      t.setRepeatCount(c.path("repeatCount").asInt(0));
      t.setRepeatInterval(c.path("repeatInterval").asLong(0));
      t.setTimesTriggered(c.path("timesTriggered").asInt(0));
      // validate()는 이름과 잡 키도 보므로 반복 간격 규칙만 따로 확인한다(SimpleTriggerImpl.validate)
      if (t.getRepeatCount() != 0 && t.getRepeatInterval() < 1) {
        throw new IllegalArgumentException("Repeat Interval cannot be zero.");
      }
    } catch (IllegalArgumentException e) {
      r.put("error", e.getMessage());
      return r;
    }
    sequence(r, t.computeFirstFireTime(null), c.path("count").asInt(5), t::getFireTimeAfter);
    afters(r, c, t::getFireTimeAfter);
    return r;
  }

  static ObjectNode timeZone(JsonNode c) {
    ObjectNode r = echo(c);
    TimeZone tz = TimeZone.getTimeZone(c.path("id").asText());
    r.put("resolvedId", tz.getID());
    r.put("zoneId", tz.toZoneId().getId());
    r.put("rawOffset", tz.getRawOffset());
    ArrayNode at = r.putArray("at");
    ArrayNode offsets = r.putArray("offsets");
    if (c.has("at")) {
      for (long t : CronVectors.fromValues(c.get("at"))) {
        at.add(t);
        offsets.add(tz.getOffset(t));
      }
    }
    return r;
  }

  static ObjectNode properties(JsonNode c) {
    ObjectNode r = echo(c);
    Properties p = new Properties();
    try {
      // Quartz는 JobDataMap을 Properties.store()로 저장한다. store/load는 ISO-8859-1이다
      p.load(new ByteArrayInputStream(c.path("text").asText().getBytes(StandardCharsets.ISO_8859_1)));
    } catch (Exception e) {
      r.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
      return r;
    }
    ObjectNode entries = r.putObject("entries");
    for (String key : new TreeSet<>(p.stringPropertyNames())) {
      entries.put(key, p.getProperty(key));
    }
    return r;
  }

  private interface FireTimeAfter {
    Date apply(Date after);
  }

  private static void sequence(ObjectNode r, Date first, int count, FireTimeAfter next) {
    ArrayNode fires = r.putArray("fireTimes");
    Date cursor = first;
    for (int i = 0; i < count && cursor != null; i++) {
      fires.add(cursor.getTime());
      cursor = next.apply(cursor);
    }
  }

  private static void afters(ObjectNode r, JsonNode c, FireTimeAfter next) {
    if (!c.has("after")) {
      return;
    }
    ArrayNode out = r.putArray("afterResults");
    for (long after : CronVectors.fromValues(c.get("after"))) {
      ObjectNode a = F.objectNode();
      a.put("after", after);
      Date d = next.apply(new Date(after));
      if (d == null) {
        a.putNull("next");
      } else {
        a.put("next", d.getTime());
      }
      out.add(a);
    }
  }

  /** 입력을 그대로 담아 결과만 보고도 비교할 수 있게 한다 */
  private static ObjectNode echo(JsonNode c) {
    return c.isObject() ? ((ObjectNode) c).deepCopy() : F.objectNode();
  }

  private static long time(JsonNode n) {
    return CronVectors.fromValues(n).get(0);
  }
}
