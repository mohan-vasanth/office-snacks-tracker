package com.office.snacks.repository;
import com.office.snacks.entity.Snack;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.*;
public interface SnackRepository extends JpaRepository<Snack,Long> { List<Snack> findAllByOrderByNameAsc(); boolean existsByNameIgnoreCase(String name); }
