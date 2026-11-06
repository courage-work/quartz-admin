package quartzadmin.testbed;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.text.ParseException;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.TimeZone;
import org.quartz.CronExpression;

/**
 * {@code cron-vectors} 서브커맨드. 실제 Quartz {@link CronExpression}으로 다음 실행 시각을 계산해 TypeScript 이식본의 기준값을
 * 만든다(TRD §6.2).
 *
 * <p>입력:
 *
 * <pre>
 * {"count": 20,
 *  "cases": [{"id": "dst-ny-1", "cron": "0 30 2 * * ?", "timeZone": "America/New_York",
 *             "from": ["2026-03-08T00:00:00Z", 1772928000000]}]}
 * </pre>
 *
 * <p>{@code from}은 ISO-8601 문자열이나 epoch ms이고, 하나만 줄 때는 배열이 아니어도 된다. 결과는 (case, from) 조합마다 하나씩
 * 나오며 {@code next}는 epoch ms, {@code nextLocal}은 해당 타임존의 ISO-8601 문자열이다. 표현식이 잘못되면 case마다 {@code
 * error}에 Quartz의 오류 메시지를, 파싱은 되지만 계산 중 예외가 나면 {@code runtimeError}에 예외 이름을 담는다.
 */
public final class CronVectors {

  public static final int DEFAULT_COUNT = 20;

  private static final JsonNodeFactory F = JsonNodeFactory.instance;

  private CronVectors() {}

  public static ObjectNode generate(JsonNode input) {
    int count = input.path("count").asInt(DEFAULT_COUNT);
    if (count < 1 || count > 1000) {
      throw new IllegalArgumentException("count는 1~1000이어야 합니다: " + count);
    }
    JsonNode cases = input.get("cases");
    if (cases == null || !cases.isArray()) {
      throw new IllegalArgumentException("cases 배열이 필요합니다");
    }
    ObjectNode out = F.objectNode();
    out.put("quartzVersion", Main.quartzVersion());
    out.put("javaVersion", System.getProperty("java.version"));
    out.put("count", count);
    ArrayNode results = out.putArray("results");
    for (JsonNode c : cases) {
      generateCase(c, count, results);
    }
    return out;
  }

  private static void generateCase(JsonNode c, int count, ArrayNode results) {
    String cron = c.path("cron").asText(null);
    if (cron == null) {
      throw new IllegalArgumentException("cron 값이 없는 case가 있습니다: " + c);
    }
    String tzId = c.path("timeZone").asText("UTC");
    TimeZone tz = TimeZone.getTimeZone(tzId);

    CronExpression expr = null;
    String error = null;
    try {
      expr = new CronExpression(cron);
      expr.setTimeZone(tz);
    } catch (ParseException e) {
      error = e.getMessage();
    }

    if (expr == null) {
      ObjectNode r = base(c, cron, tzId, tz);
      r.put("error", error);
      results.add(r);
      return;
    }

    for (long from : fromValues(c.get("from"))) {
      ObjectNode r = base(c, cron, tzId, tz);
      r.put("from", from);
      ArrayNode next = r.putArray("next");
      ArrayNode nextLocal = r.putArray("nextLocal");
      ZoneId zone = tz.toZoneId();
      Date cursor = new Date(from);
      try {
        for (int i = 0; i < count; i++) {
          cursor = expr.getTimeAfter(cursor);
          if (cursor == null) {
            break;
          }
          next.add(cursor.getTime());
          nextLocal.add(
              DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(cursor.toInstant().atZone(zone)));
        }
      } catch (RuntimeException e) {
        // 파싱은 통과하지만 계산에서 터지는 표현식(예: 2.3.2의 'L * * * * ?')
        r.put("runtimeError", e.getClass().getSimpleName());
      }
      results.add(r);
    }
  }

  private static ObjectNode base(JsonNode c, String cron, String tzId, TimeZone tz) {
    ObjectNode r = F.objectNode();
    if (c.hasNonNull("id")) {
      r.set("id", c.get("id"));
    }
    r.put("cron", cron);
    r.put("timeZone", tzId);
    // Java는 모르는 ID를 조용히 GMT로 바꾼다. 비교하는 쪽이 알 수 있게 실제로 쓴 ID를 남긴다
    r.put("resolvedTimeZone", tz.getID());
    return r;
  }

  static List<Long> fromValues(JsonNode node) {
    if (node == null || node.isNull()) {
      throw new IllegalArgumentException("from 값이 필요합니다");
    }
    List<Long> values = new ArrayList<>();
    if (node.isArray()) {
      for (JsonNode n : node) {
        values.add(instant(n));
      }
    } else {
      values.add(instant(node));
    }
    return values;
  }

  private static long instant(JsonNode n) {
    if (n.isNumber()) {
      return n.asLong();
    }
    return Instant.parse(n.asText()).toEpochMilli();
  }
}
