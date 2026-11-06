package quartzadmin.testbed;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class CoreVectorsTest {

  private static final ObjectMapper JSON = new ObjectMapper();

  private static JsonNode run(String input) throws Exception {
    return CoreVectors.generate(JSON.readTree(input));
  }

  @Test
  void CronTrigger는_시작_시각_1초_전부터_첫_시각을_찾고_종료_시각을_지킨다() throws Exception {
    JsonNode r =
        run(
            """
            {"cronTriggers":[{"id":"a","cron":"0 0 * * * ?","timeZone":"UTC",
              "startTime":"2026-01-01T10:00:00.500Z","endTime":"2026-01-01T12:00:00Z","count":5,
              "after":["2026-01-01T09:00:00Z","2026-01-01T12:00:00Z"]}]}
            """)
            .get("cronTriggers")
            .get(0);
    // 밀리초는 버린다
    assertEquals(1767261600000L, r.get("normalizedStartTime").asLong());
    // 10:00, 11:00, 12:00(종료 시각과 같으면 포함)
    assertEquals(3, r.get("fireTimes").size());
    assertEquals(1767261600000L, r.get("fireTimes").get(0).asLong());
    // 시작 전 시각을 주면 시작 시각부터 찾는다
    assertEquals(1767261600000L, r.get("afterResults").get(0).get("next").asLong());
    // 종료 시각 이후는 없다
    assertTrue(r.get("afterResults").get(1).get("next").isNull());
    // 입력을 그대로 남긴다
    assertEquals("0 0 * * * ?", r.get("cron").asText());
  }

  @Test
  void SimpleTrigger는_반복_횟수만큼_시각을_만든다() throws Exception {
    JsonNode r =
        run(
            """
            {"simpleTriggers":[{"startTime":1000000,"repeatCount":2,"repeatInterval":60000,"count":10}]}
            """)
            .get("simpleTriggers")
            .get(0);
    assertEquals("[1000000,1060000,1120000]", r.get("fireTimes").toString());
  }

  @Test
  void 반복_간격이_0이면_오류를_남긴다() throws Exception {
    JsonNode r =
        run(
            """
            {"simpleTriggers":[{"startTime":0,"repeatCount":1,"repeatInterval":0}]}
            """)
            .get("simpleTriggers")
            .get(0);
    assertEquals("Repeat Interval cannot be zero.", r.get("error").asText());
  }

  @Test
  void 타임존은_Java가_해석한_ID와_오프셋을_남긴다() throws Exception {
    JsonNode out =
        run(
            """
            {"timeZones":[{"id":"GMT+9","at":[0]},{"id":"Nope/Zone","at":[0]}]}
            """);
    JsonNode custom = out.get("timeZones").get(0);
    assertEquals("GMT+09:00", custom.get("resolvedId").asText());
    assertEquals(9 * 3600 * 1000, custom.get("offsets").get(0).asInt());
    assertEquals("GMT", out.get("timeZones").get(1).get("resolvedId").asText());
  }

  @Test
  void properties는_JDK_파서_결과를_남긴다() throws Exception {
    JsonNode r =
        run(
            """
            {"properties":[{"text":"a=1\\n# comment\\nb : two \\\\\\n  words\\nc\\\\u00e9=\\\\u00e9"}]}
            """)
            .get("properties")
            .get(0)
            .get("entries");
    assertEquals("1", r.get("a").asText());
    assertEquals("two words", r.get("b").asText());
    assertEquals("é", r.get("cé").asText());
  }
}
