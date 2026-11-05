package quartzadmin.testbed;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class CronVectorsTest {

  private static final ObjectMapper JSON = new ObjectMapper();

  private static JsonNode run(String input) throws Exception {
    return CronVectors.generate(JSON.readTree(input));
  }

  @Test
  void 기본으로_다음_실행_시각_20개를_만든다() throws Exception {
    JsonNode out =
        run(
            """
            {"cases":[{"id":"a","cron":"0 0 12 * * ?","timeZone":"Asia/Seoul","from":"2026-01-01T00:00:00Z"}]}
            """);
    JsonNode r = out.get("results").get(0);
    assertEquals(20, out.get("count").asInt());
    assertEquals("a", r.get("id").asText());
    assertEquals(20, r.get("next").size());
    // 2026-01-01 12:00 KST = 03:00Z
    assertEquals(1767236400000L, r.get("next").get(0).asLong());
    assertEquals("2026-01-01T12:00:00+09:00", r.get("nextLocal").get(0).asText());
    assertEquals("Asia/Seoul", r.get("resolvedTimeZone").asText());
  }

  @Test
  void 기준_시각마다_결과를_하나씩_만든다() throws Exception {
    JsonNode out =
        run(
            """
            {"count":3,"cases":[{"cron":"0 0 0 L * ?","timeZone":"UTC",
              "from":["2028-02-01T00:00:00Z", 1830297600000]}]}
            """);
    assertEquals(2, out.get("results").size());
    JsonNode first = out.get("results").get(0);
    assertEquals(3, first.get("next").size());
    // 윤년 2월 말일
    assertEquals("2028-02-29T00:00:00Z", first.get("nextLocal").get(0).asText());
  }

  @Test
  void DST_시작일에는_없는_시각을_건너뛴다() throws Exception {
    JsonNode out =
        run(
            """
            {"count":2,"cases":[{"cron":"0 30 2 * * ?","timeZone":"America/New_York",
              "from":"2026-03-07T12:00:00Z"}]}
            """);
    JsonNode local = out.get("results").get(0).get("nextLocal");
    // 2026-03-08 02:30은 없는 시각이라 Quartz는 그날을 건너뛴다
    assertEquals("2026-03-09T02:30:00-04:00", local.get(0).asText());
    assertEquals("2026-03-10T02:30:00-04:00", local.get(1).asText());
  }

  @Test
  void 잘못된_표현식은_오류_메시지를_남긴다() throws Exception {
    JsonNode r =
        run("""
            {"cases":[{"cron":"0 0 25 * * ?","from":0}]}
            """)
            .get("results")
            .get(0);
    assertTrue(r.hasNonNull("error"));
    assertFalse(r.has("next"));
  }

  @Test
  void 모르는_타임존은_GMT로_해석된_것을_알린다() throws Exception {
    JsonNode r =
        run("""
            {"count":1,"cases":[{"cron":"0 0 0 * * ?","timeZone":"Mars/Base","from":0}]}
            """)
            .get("results")
            .get(0);
    assertEquals("GMT", r.get("resolvedTimeZone").asText());
  }

  @Test
  void 끝이_있는_표현식은_가능한_만큼만_만든다() throws Exception {
    JsonNode r =
        run(
            """
            {"cases":[{"cron":"0 0 0 1 1 ? 2030","timeZone":"UTC","from":"2026-01-01T00:00:00Z"}]}
            """)
            .get("results")
            .get(0);
    assertEquals(1, r.get("next").size());
  }
}
